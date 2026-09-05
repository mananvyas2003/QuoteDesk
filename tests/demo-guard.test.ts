import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDb } from "./helpers/db";

/**
 * Task 8 guards — the demo must not be mistakable for a measurement.
 *
 * A synthetic corpus that renders exactly like a real one is the failure mode
 * that gets a wrong number quoted in a pitch.
 */

const require_ = createRequire(import.meta.url);
const tsxCli = require_.resolve("tsx/cli");
const prismaCli = require_.resolve("prisma/build/index.js");

function run(script: string, args: string[], env: Record<string, string>) {
  try {
    const stdout = execFileSync(process.execPath, [tsxCli, script, ...args], {
      env: { ...process.env, ...env },
      stdio: "pipe",
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

/** A fresh database the seed script can own, separate from the shared test db. */
function freshDbUrl(): string {
  const dir = mkdtempSync(join(tmpdir(), "quotedesk-seed-"));
  const url = `file:${join(dir, "seed.db").replace(/\\/g, "/")}`;
  execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate", "--accept-data-loss"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  return url;
}

let seedUrl: string;
before(() => {
  seedUrl = freshDbUrl();
});

test("db:seed refuses to run without an explicit --demo flag", () => {
  const r = run("prisma/seed.ts", [], { DATABASE_URL: seedUrl });
  assert.notEqual(r.code, 0, "loading a synthetic corpus must be a deliberate act");
  assert.match(r.stderr, /--demo/);
  assert.match(r.stderr, /synthetic/i);
});

test("db:seed --demo loads the corpus and marks the workspace as demo", async () => {
  const r = run("prisma/seed.ts", ["--demo"], { DATABASE_URL: seedUrl });
  assert.equal(r.code, 0, r.stderr);

  const { PrismaClient } = require_("@prisma/client") as typeof import("@prisma/client");
  const client = new PrismaClient({ datasources: { db: { url: seedUrl } } });
  try {
    const ws = await client.workspace.findFirstOrThrow();
    assert.equal(ws.isDemo, true, "a seeded workspace must be flagged as demo");
    const lines = await client.historicalQuoteLine.count();
    assert.ok(lines > 0, "the demo corpus should still load lines for UI smoke-testing");
  } finally {
    await client.$disconnect();
  }
});

test("a workspace with no corpus and no demo flag fails loudly, pointing at PRD §7", async () => {
  const prisma = await testDb();
  await prisma.workspace.create({
    data: { name: "Empty Shop", isDemo: false, capabilityEnvelope: "{}" },
  });
  const { assertUsableCorpus } = await import("../src/lib/workspace");
  const empty = await prisma.workspace.findFirstOrThrow({ where: { name: "Empty Shop" } });

  await assert.rejects(
    () => assertUsableCorpus(empty),
    (err: Error) => {
      assert.match(err.message, /§7/, "the error must point at the PRD section it violates");
      assert.match(err.message, /no history, no onboarding/i);
      assert.match(err.message, /--demo/, "the error must say how to load the demo instead");
      return true;
    },
  );
});

test("a demo workspace passes the corpus gate but is flagged for the banner", async () => {
  const prisma = await testDb();
  const demo = await prisma.workspace.create({
    data: { name: "Demo Shop", isDemo: true, capabilityEnvelope: "{}" },
  });
  const { assertUsableCorpus } = await import("../src/lib/workspace");

  // Demo workspaces are allowed through so the UI is smoke-testable...
  await assertUsableCorpus(demo);
  // ...but they are never mistakable for real data.
  assert.equal(demo.isDemo, true);
});

test("a workspace with a real corpus passes the gate", async () => {
  const prisma = await testDb();
  const ws = await prisma.workspace.create({
    data: { name: "Real Shop", isDemo: false, capabilityEnvelope: "{}" },
  });
  await prisma.historicalQuote.create({
    data: {
      workspaceId: ws.id,
      quoteNumber: "R-1",
      quotedAt: new Date(),
      lines: { create: [{ description: "Real part", qty: 10, unitPrice: 5 }] },
    },
  });

  const { assertUsableCorpus } = await import("../src/lib/workspace");
  await assertUsableCorpus(ws);
});
