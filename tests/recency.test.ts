import { before, test } from "node:test";
import assert from "node:assert/strict";
import { testDb, monthsAgo } from "./helpers/db";
import { priceFromCandidates, resolveAgainstHistory, type Comparable } from "../src/lib/resolve";
import { PRICING_CONFIG, recencyWeight } from "../src/lib/pricing";

/**
 * Task 5 guards. `asOfDate` only ever gated a 12-month cutoff. Inside that
 * window a 20-month-old price and last month's price carried equal weight,
 * despite material cost movement.
 */

function comparable(over: Partial<Comparable> & { qty: number; unitPrice: number }): Comparable {
  return {
    id: `r-${over.qty}-${over.unitPrice}-${over.quotedAt?.getTime() ?? 0}`,
    description: "Angle clip 3x3x0.25",
    partNumber: "AC-33",
    sku: "FAB-AC-33",
    quotedAt: monthsAgo(1),
    scope: "account",
    outcome: null,
    competitorPrice: null,
    costIndex: null,
    ...over,
  };
}

test("a recent comparable outweighs an old one at the same quantity", () => {
  const priced = priceFromCandidates(
    [
      comparable({ qty: 100, unitPrice: 10, quotedAt: monthsAgo(1) }),
      comparable({ qty: 100, unitPrice: 20, quotedAt: monthsAgo(11) }),
    ],
    100,
  );
  assert.ok(priced.unitPrice != null);
  assert.ok(
    priced.unitPrice! < 15,
    `both prices are inside the 12-month window, but the recent one must dominate; got ${priced.unitPrice}`,
  );
});

test("the decay is exponential with the configured half-life", () => {
  const h = PRICING_CONFIG.recencyHalfLifeMonths;
  assert.equal(h, 9, "documented default half-life");
  assert.equal(recencyWeight(0, h), 1);
  assert.ok(Math.abs(recencyWeight(h, h) - 0.5) < 1e-9, "one half-life halves the weight");
  assert.ok(Math.abs(recencyWeight(2 * h, h) - 0.25) < 1e-9);
});

test("a supplied cost index back-adjusts a historical price", () => {
  const pool = [
    comparable({ qty: 100, unitPrice: 10, costIndex: 100 }),
    comparable({ qty: 100, unitPrice: 10, costIndex: 100 }),
  ];
  // Material has risen 20% since those quotes.
  const priced = priceFromCandidates(pool, 100, { currentCostIndex: 120 });
  assert.ok(priced.unitPrice != null);
  assert.ok(
    Math.abs(priced.unitPrice! - 12) < 0.01,
    `expected 10 x (120/100) = 12, got ${priced.unitPrice}`,
  );
});

test("no index means no adjustment — an index is never invented", () => {
  const pool = [
    comparable({ qty: 100, unitPrice: 10, costIndex: null }),
    comparable({ qty: 100, unitPrice: 10, costIndex: null }),
  ];
  assert.equal(priceFromCandidates(pool, 100, { currentCostIndex: 120 }).unitPrice, 10);
  assert.equal(priceFromCandidates(pool, 100).unitPrice, 10);
});

let workspaceId: string;
before(async () => {
  const prisma = await testDb();
  const ws = await prisma.workspace.create({
    data: { name: "Recency Test Shop", capabilityEnvelope: "{}" },
  });
  await prisma.historicalQuote.create({
    data: {
      workspaceId: ws.id,
      quoteNumber: "RQ-1",
      quotedAt: monthsAgo(2),
      lines: {
        create: [
          {
            description: "Index bracket",
            partNumber: "IDX-1",
            qty: 100,
            unitPrice: 10,
            costIndex: 105,
          },
        ],
      },
    },
  });
  workspaceId = ws.id;
});

test("costIndex is persisted per historical line and reaches the pricing path", async () => {
  const result = await resolveAgainstHistory(workspaceId, {
    partNumber: "IDX-1",
    description: "Index bracket",
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].costIndex, 105);
  assert.equal(
    result.currentCostIndex,
    105,
    "the newest available index is the reference point; null when the shop supplies none",
  );
});
