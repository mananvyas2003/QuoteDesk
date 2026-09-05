import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDb } from "./helpers/db";
import { loadInput, parseCsv } from "../scripts/lib/backtestInput";

/** Task 7 guards — the harness must refuse to produce a meaningless number. */

const require_ = createRequire(import.meta.url);
const tsxCli = require_.resolve("tsx/cli");

/** Runs scripts/backtest.ts and returns { code, stderr }. */
function runBacktest(args: string[], env: Record<string, string> = {}) {
  try {
    execFileSync(process.execPath, [tsxCli, "scripts/backtest.ts", ...args], {
      env: { ...process.env, ...env },
      stdio: "pipe",
      encoding: "utf8",
    });
    return { code: 0, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stderr: string };
    return { code: err.status, stderr: String(err.stderr ?? "") };
  }
}

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "quotedesk-bt-"));
});

test("with no input it exits non-zero and says K3 needs real data", () => {
  const r = runBacktest([]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /K3 cannot be measured without real data/);
});

test("it refuses to run on a demo workspace", async () => {
  const prisma = await testDb();
  const demo = await prisma.workspace.create({
    data: { name: "Demo Corpus Shop", isDemo: true, capabilityEnvelope: "{}" },
  });

  const r = runBacktest(["--workspace", demo.id], {
    DATABASE_URL: process.env.DATABASE_URL!,
  });
  assert.notEqual(r.code, 0, "a demo workspace must not produce a K3 number");
  assert.match(r.stderr, /isDemo = true/);
  assert.match(r.stderr, /synthetic/i);
});

test("it refuses a data file that is the prisma/seed.ts corpus", () => {
  const path = join(dir, "seed-lookalike.csv");
  writeFileSync(
    path,
    [
      "quote_number,quoted_at,part_number,description,qty,unit_price",
      "Q-4412,2026-01-04,BP-1218,Base plate 12x18x0.5,50,48.50",
      "Q-4388,2025-12-04,BP-1218,Base plate 12x18x0.5,25,52.00",
      "Q-4301,2025-11-04,BP-1218,Base plate 12x18x0.5,40,49.25",
      "Q-4502,2025-10-04,SC-200,SS shaft collar 2in,80,22.40",
      "Q-4471,2025-09-04,WF-2436,Weldment frame 24x36,8,400.00",
      "PO-4471,2025-08-04,WF-2436,Weldment frame 24x36,12,390.00",
    ].join("\n"),
    "utf8",
  );

  const r = runBacktest(["--data", path]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /prisma\/seed\.ts/);
  assert.match(r.stderr, /meaningless/i);
});

test("it runs end-to-end on the documented format and writes every required section", () => {
  const out = join(dir, "report.md");
  const r = runBacktest([
    "--data",
    "scripts/fixtures/format-example.csv",
    "--costs",
    "scripts/fixtures/format-example-costs.csv",
    "--out",
    out,
  ]);
  assert.equal(r.code, 0, r.stderr);

  const report = require_("node:fs").readFileSync(out, "utf8") as string;
  for (const section of [
    "## Corpus",
    "## K3 verdict",
    "## Relative error distribution",
    "## Confidence-state distribution",
    "### Error within GREEN specifically",
    "## Error by quantity bucket",
    "## Error by pricing method",
    "## Lines that could not be predicted",
  ]) {
    assert.ok(report.includes(section), `report is missing "${section}"`);
  }
  assert.match(report, /\| p10 \| p50 \| p70 \| p90 \| p99 \|/, "percentiles, not the mean");
  assert.match(report, /K3 threshold: ≥70%/);
  assert.match(report, /\*\*(PASS|FAIL)\*\*/, "the K3 verdict must be stated explicitly");
});

test("the CSV parser handles quoted fields, embedded commas and doubled quotes", () => {
  const rows = parseCsv(
    'a,b,c\n1,"hello, world","say ""hi"""\n2,plain,x\n',
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].b, "hello, world");
  assert.equal(rows[0].c, 'say "hi"');
  assert.equal(rows[1].b, "plain");
});

test("a malformed row fails loudly rather than being silently dropped", () => {
  const path = join(dir, "bad.csv");
  writeFileSync(
    path,
    "quote_number,quoted_at,description,qty,unit_price\nQ-1,2026-01-01,Widget,0,10.00\n",
    "utf8",
  );
  assert.throws(() => loadInput(path), /qty is missing or not positive/);
});

test("an unrecognised outcome value is rejected, not coerced", () => {
  const path = join(dir, "bad-outcome.csv");
  writeFileSync(
    path,
    "quote_number,quoted_at,description,qty,unit_price,outcome\nQ-1,2026-01-01,Widget,10,10.00,maybe\n",
    "utf8",
  );
  assert.throws(() => loadInput(path), /won \| lost \| no_decision/);
});
