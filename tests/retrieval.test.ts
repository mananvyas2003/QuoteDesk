import { before, test } from "node:test";
import assert from "node:assert/strict";
import { testDb, monthsAgo } from "./helpers/db";
import { classifyMatch, resolveAgainstHistory } from "../src/lib/resolve";
import { parseRfqInput } from "../src/lib/extract";

/** Task 3 guards — candidate retrieval. */

type Ctx = { workspaceId: string; acmeId: string; newAccountId: string };

async function seedCorpus(): Promise<Ctx> {
  const prisma = await testDb();
  const workspace = await prisma.workspace.create({
    data: { name: "Retrieval Test Shop", capabilityEnvelope: "{}" },
  });
  const acme = await prisma.account.create({
    data: { workspaceId: workspace.id, name: "Acme", domain: "acme.example" },
  });
  const newAccount = await prisma.account.create({
    data: { workspaceId: workspace.id, name: "Brand New", domain: "brandnew.example" },
  });

  // 700 filler lines, all older than the target, inserted first. Under the old
  // `take: 500` with no orderBy these alone could fill the entire pool.
  const filler = await prisma.historicalQuote.create({
    data: {
      workspaceId: workspace.id,
      accountId: acme.id,
      quoteNumber: "Q-FILLER",
      quotedAt: monthsAgo(6),
    },
  });
  await prisma.historicalQuoteLine.createMany({
    data: Array.from({ length: 700 }, (_, i) => ({
      historicalQuoteId: filler.id,
      description: `Filler widget variant ${i}`,
      partNumber: `FILL-${i}`,
      material: "A36",
      qty: 10,
      unitPrice: 5,
    })),
  });

  // The item we actually want, inserted last.
  const target = await prisma.historicalQuote.create({
    data: {
      workspaceId: workspace.id,
      accountId: acme.id,
      quoteNumber: "Q-TARGET",
      quotedAt: monthsAgo(2),
    },
  });
  await prisma.historicalQuoteLine.createMany({
    data: [50, 100, 250].map((qty, i) => ({
      historicalQuoteId: target.id,
      description: "Needle bracket 4x4",
      partNumber: "NEEDLE-1",
      material: "A36",
      qty,
      unitPrice: 20 - i * 3,
    })),
  });

  return { workspaceId: workspace.id, acmeId: acme.id, newAccountId: newAccount.id };
}

let ctx: Ctx;
before(async () => {
  ctx = await seedCorpus();
});

test("3a: a corpus larger than the old take:500 still finds the matching item", async () => {
  const result = await resolveAgainstHistory(
    ctx.workspaceId,
    { partNumber: "NEEDLE-1", description: "Needle bracket 4x4", material: "A36" },
    ctx.acmeId,
  );

  assert.equal(result.matchType, "exact");
  assert.equal(
    result.candidates.length,
    3,
    "all three NEEDLE-1 lines must be retrieved from a 703-line corpus",
  );
});

test("3a: pool truncation is surfaced as a blocker, not silently dropped", async () => {
  const result = await resolveAgainstHistory(
    ctx.workspaceId,
    { partNumber: "NEEDLE-1", description: "Needle bracket 4x4" },
    ctx.acmeId,
    { caps: { accountScanCap: 10, workspaceScanCap: 10 } },
  );

  const blocker = result.blockers.find((b) => b.code === "candidate_pool_truncated");
  assert.ok(blocker, "a truncated scan must raise a blocker");
  assert.equal(blocker.kind, "assumable");
});

test("3b: an account with no history falls back to workspace-wide comparables", async () => {
  const result = await resolveAgainstHistory(
    ctx.workspaceId,
    { partNumber: "NEEDLE-1", description: "Needle bracket 4x4" },
    ctx.newAccountId,
  );

  assert.notEqual(result.matchType, "none", "a new account must not be 100% RED with no fallback");
  assert.ok(result.candidates.length > 0);
  assert.ok(
    result.candidates.every((c) => c.scope === "workspace"),
    "comparables found outside the account must be tagged workspace scope",
  );
  assert.ok(
    result.blockers.some((b) => b.code === "no_account_history" && b.kind === "assumable"),
    "pricing a new account off another customer's history is an assumption, and must be stated",
  );
});

test("3b: an account's own history is tagged account scope and weighted higher", async () => {
  const result = await resolveAgainstHistory(
    ctx.workspaceId,
    { partNumber: "NEEDLE-1", description: "Needle bracket 4x4" },
    ctx.acmeId,
  );
  assert.ok(result.candidates.every((c) => c.scope === "account"));
  assert.ok(!result.blockers.some((b) => b.code === "no_account_history"));

  const { PRICING_CONFIG } = await import("../src/lib/pricing");
  assert.ok(
    PRICING_CONFIG.scopeWeights.account > PRICING_CONFIG.scopeWeights.workspace,
    "customer-specific pricing is real; account history must outweigh workspace history",
  );
});

test("3c: the exact / near / weak boundary is one explicit comparison", () => {
  assert.equal(classifyMatch(0.98), "exact");
  assert.equal(classifyMatch(0.92), "exact");
  assert.equal(classifyMatch(0.91), "near");
  assert.equal(classifyMatch(0.75), "near");
  assert.equal(classifyMatch(0.74), "weak");
  assert.equal(classifyMatch(0.35), "weak");
  assert.equal(classifyMatch(0.34), "none");
});

test("3d: a same-as note alongside a line table is a conflict on the affected line", () => {
  const parsed = parseRfqInput({
    body: `Same as PO 4471 but 400 units.

Part | Description | Qty | Material
WF-2436 | Weldment frame 24x36 | 25 | A572
`,
    fileName: "rfq.txt",
  });

  // Both extractors run; the prose note is no longer discarded because a table
  // happened to parse first.
  assert.ok(
    parsed.lines.length >= 2,
    `expected the table row and the same-as note, got ${parsed.lines.length}`,
  );

  const conflicted = parsed.lines.filter((l) =>
    l.blockers.some((b) => b.code === "qty_conflict"),
  );
  assert.ok(conflicted.length > 0, "the contradiction must land on a line as a blocker");
  assert.ok(
    conflicted.every((l) => l.blockers.some((b) => b.code === "qty_conflict" && b.kind === "unassumable")),
    "contradictory quantities cannot be assumed away — the line must go RED",
  );
});

test("3d: prose lines are still extracted when no table is present", () => {
  const parsed = parseRfqInput({
    body: `Morning — we need 40 SS shaft collar 2in, SS304, passivate.`,
    fileName: "rfq.txt",
  });
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].qty, 40);
});

test("3d: a table row is not duplicated by the prose extractor", () => {
  const parsed = parseRfqInput({
    body: `Please price the below.

Part | Description | Qty | Material
GB-88 | Guard bracket laser cut | 100 | A36
`,
    fileName: "rfq.txt",
  });
  assert.equal(parsed.lines.length, 1, "merging the two extractors must not double-count a line");
});
