import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";

/**
 * Provisions a throwaway SQLite database from the current Prisma schema and
 * returns a client bound to it.
 *
 * Scripts that measure pipeline behaviour must never touch the developer's
 * dev.db (which usually holds the demo corpus). Each run gets a fresh file.
 */
export async function openScratchDb(label: string): Promise<{
  prisma: PrismaClient;
  dir: string;
  url: string;
  close: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), `quotedesk-${label}-`));
  const url = `file:${join(dir, "scratch.db").replace(/\\/g, "/")}`;

  // Invoke the Prisma CLI's JS entry directly rather than `npx`, which needs a
  // shell on Windows.
  const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate", "--accept-data-loss"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  // PrismaClient reads DATABASE_URL when it is constructed, so the env var has
  // to be set before src/lib/db.ts is evaluated.
  process.env.DATABASE_URL = url;
  const { prisma } = await import("../../src/lib/db");

  return {
    prisma,
    dir,
    url,
    close: async () => {
      await prisma.$disconnect();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows sometimes keeps the sqlite handle briefly; a leaked temp dir
        // is not worth failing a report run over.
      }
    },
  };
}
