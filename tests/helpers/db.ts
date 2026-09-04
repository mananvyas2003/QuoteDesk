import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";

/**
 * A throwaway SQLite database per test file.
 *
 * Tests that exercise the retrieval path need real queries, but must never
 * touch dev.db and must never use `prisma/seed.ts` — the seed corpus is
 * invented data and any measurement against it is meaningless. Every fixture
 * here is built inside the test that asserts on it, and asserts *behaviour*
 * (does this code path do what it claims), never pricing accuracy.
 */
let cached: { prisma: PrismaClient; dir: string } | null = null;

export async function testDb(): Promise<PrismaClient> {
  if (cached) return cached.prisma;

  const dir = mkdtempSync(join(tmpdir(), "quotedesk-test-"));
  const url = `file:${join(dir, "test.db").replace(/\\/g, "/")}`;
  const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate", "--accept-data-loss"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  process.env.DATABASE_URL = url;
  const { prisma } = await import("../../src/lib/db");
  cached = { prisma, dir };

  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  return prisma;
}

export function monthsAgo(n: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}
