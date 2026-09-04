import { before, test } from "node:test";
import assert from "node:assert/strict";
import { testDb, monthsAgo } from "./helpers/db";
import { priceFromCandidates, resolveAgainstHistory, type Comparable } from "../src/lib/resolve";
import { PRICING_CONFIG } from "../src/lib/pricing";

/**
 * Task 4 guards. The pricing path averages *quoted* prices, including quotes
 * that lost because the price was too high. Weighting by recorded outcome stops
 * the derived price regressing toward prices with no established relationship
 * to what wins.
 */

function comparable(over: Partial<Comparable> & { qty: number; unitPrice: number }): Comparable {
  return {
    id: `c-${over.qty}-${over.unitPrice}-${over.outcome ?? "none"}`,
    description: "Guard bracket laser cut",
    partNumber: "GB-88",
    sku: "FAB-GB-88",
    quotedAt: monthsAgo(2),
    scope: "account",
    outcome: null,
    competitorPrice: null,
    costIndex: null,
    ...over,
  };
}

let ctx: { workspaceId: string; accountId: string };
before(async () => {
  const prisma = await testDb();
  const workspace = await prisma.workspace.create({
    data: { name: "Outcome Test Shop", capabilityEnvelope: "{}" },
  });
  const account = await prisma.account.create({
    data: { workspaceId: workspace.id, name: "Outcome Co", domain: "outcome.example" },
  });

  const quotes: Array<{ n: string; months: number; outcome: string | null; comp: number | null; price: number }> = [
    { n: "OQ-1", months: 1, outcome: "won", comp: null, price: 10 },
    { n: "OQ-2", months: 2, outcome: "lost", comp: 9.0, price: 20 },
    { n: "OQ-3", months: 3, outcome: null, comp: null, price: 12 },
  ];
  for (const q of quotes) {
    await prisma.historicalQuote.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        quoteNumber: q.n,
        quotedAt: monthsAgo(q.months),
        outcome: q.outcome,
        competitorPrice: q.comp,
        lines: {
          create: [
            {
              description: "Outcome bracket",
              partNumber: "OUT-1",
              material: "A36",
              qty: 100,
              unitPrice: q.price,
            },
          ],
        },
      },
    });
  }

  ctx = { workspaceId: workspace.id, accountId: account.id };
});

test("retrieval carries each comparable's recorded outcome into the pricing path", async () => {
  const result = await resolveAgainstHistory(
    ctx.workspaceId,
    { partNumber: "OUT-1", description: "Outcome bracket" },
    ctx.accountId,
  );

  assert.equal(result.candidates.length, 3);
  const outcomes = new Set(result.candidates.map((c) => c.outcome));
  assert.deepEqual(outcomes, new Set(["won", "lost", null]));

  const lost = result.candidates.find((c) => c.outcome === "lost");
  assert.equal(lost!.competitorPrice, 9.0, "a known competitor price must reach the pricing path");
});

test("a lost quote pulls the derived price far less than a won quote", () => {
  const pool = [
    comparable({ qty: 100, unitPrice: 10, outcome: "won" }),
    comparable({ qty: 100, unitPrice: 20, outcome: "lost" }),
  ];
  const priced = priceFromCandidates(pool, 100);
  const unweightedMean = 15;

  assert.ok(priced.unitPrice != null);
  assert.ok(
    priced.unitPrice! < unweightedMean,
    `expected the lost quote to be discounted, got ${priced.unitPrice}`,
  );
  // won 1.0 vs lost 0.15 -> (10*1.0 + 20*0.15) / 1.15 = 11.30
  assert.ok(priced.unitPrice! < 12, `expected ~11.3, got ${priced.unitPrice}`);
});

test("a comparable with no recorded outcome keeps full weight", () => {
  const withNone = priceFromCandidates(
    [comparable({ qty: 100, unitPrice: 10 }), comparable({ qty: 100, unitPrice: 20 })],
    100,
  );
  // Both unknown and equally recent: the weighted mean is the plain mean.
  assert.equal(Math.round(withNone.unitPrice! * 100) / 100, 15);
  assert.equal(PRICING_CONFIG.outcomeWeights.unknown, 1.0);
});

test("a known competitor price below our derived price is a stated assumption", () => {
  const pool = [
    comparable({ qty: 100, unitPrice: 10, outcome: "won" }),
    comparable({ qty: 100, unitPrice: 20, outcome: "lost", competitorPrice: 9.0 }),
  ];
  const priced = priceFromCandidates(pool, 100);

  const blocker = priced.blockers.find((b) => b.code === "prior_loss_below_price");
  assert.ok(blocker, "a censored upper bound from a prior loss must be surfaced");
  assert.equal(blocker.kind, "assumable");
  assert.match(blocker.detail, /9(\.00)?/);
});

test("the outcome weights are the documented defaults", () => {
  assert.equal(PRICING_CONFIG.outcomeWeights.won, 1.0);
  assert.equal(PRICING_CONFIG.outcomeWeights.no_decision, 0.5);
  assert.equal(PRICING_CONFIG.outcomeWeights.lost, 0.15);
});
