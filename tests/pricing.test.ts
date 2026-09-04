import { test } from "node:test";
import assert from "node:assert/strict";
import { priceFromCandidates } from "../src/lib/resolve";
import type { Comparable } from "../src/lib/resolve";

/**
 * Task 2 guards. In fabrication, unit price versus quantity is the dominant
 * curve because setup cost amortises. Averaging a unit price at qty 10 with one
 * at qty 1000 is wrong for both.
 */

function monthsAgo(n: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}

function comparable(qty: number, unitPrice: number, months = 2): Comparable {
  return {
    id: `h-${qty}-${unitPrice}`,
    description: "Angle clip 3x3x0.25",
    partNumber: "AC-33",
    sku: "FAB-AC-33",
    qty,
    unitPrice,
    quotedAt: monthsAgo(months),
    scope: "account",
    outcome: null,
    competitorPrice: null,
    costIndex: null,
  };
}

/** A normal downward setup-amortisation curve. */
const CURVE: Comparable[] = [
  comparable(10, 8.4, 1),
  comparable(50, 5.6, 2),
  comparable(100, 4.4, 3),
  comparable(250, 3.45, 4),
  comparable(500, 3.05, 5),
];

test("unit price at qty 1000 is strictly lower than at qty 10", () => {
  const low = priceFromCandidates(CURVE, 10);
  const high = priceFromCandidates(CURVE, 1000);

  assert.ok(low.unitPrice != null, "qty 10 must price");
  assert.ok(high.unitPrice != null, "qty 1000 must price");
  assert.ok(
    high.unitPrice! < low.unitPrice!,
    `expected qty 1000 unit price (${high.unitPrice}) < qty 10 (${low.unitPrice})`,
  );
  assert.equal(low.method, "loglog_fit");
  assert.equal(high.method, "loglog_fit");
});

test("the fit is evaluated at the requested quantity, not averaged", () => {
  const mean = CURVE.reduce((s, c) => s + c.unitPrice, 0) / CURVE.length;
  const at10 = priceFromCandidates(CURVE, 10).unitPrice!;
  assert.notEqual(Number(at10.toFixed(4)), Number(mean.toFixed(4)));
  // qty 10 is the cheapest-volume end of the curve, so it must price above the
  // flat average of the whole set.
  assert.ok(at10 > mean);
});

test("a quantity 10x outside the observed range is RED, not a number", () => {
  const observed: Comparable[] = [
    comparable(10, 8.4),
    comparable(50, 5.6),
    comparable(100, 4.4),
    comparable(500, 3.05),
  ];
  const priced = priceFromCandidates(observed, 50_000);

  const blocker = priced.blockers.find((b) => b.code === "unsupportable_quantity");
  assert.ok(blocker, "qty 50,000 against a 10–500 range must raise a blocker");
  assert.equal(blocker.kind, "unassumable", "an unassumable blocker forces RED");
  assert.equal(priced.unitPrice, null, "an unsupportable quantity must not be priced");
});

test("a quantity 3x-10x outside the range is priced but AMBER, with the delta stated", () => {
  const observed: Comparable[] = [comparable(100, 4.4), comparable(200, 3.9)];
  const priced = priceFromCandidates(observed, 1000);

  assert.ok(priced.unitPrice != null);
  const blocker = priced.blockers.find((b) => b.code === "qty_extrapolated");
  assert.ok(blocker, "extrapolation beyond 3x must be surfaced");
  assert.equal(blocker.kind, "assumable");
  // The delta must be stated in the assumption the buyer sees.
  assert.match(blocker.detail, /1,?000/);
  assert.match(blocker.detail, /5\.0×/);
  assert.match(blocker.detail, /100–200/);
});

test("a single comparable is AMBER and reports its method", () => {
  const priced = priceFromCandidates([comparable(100, 4.4)], 120);
  assert.equal(priced.method, "single_comparable");
  assert.equal(priced.unitPrice, 4.4);
  assert.ok(priced.blockers.some((b) => b.code === "single_comparable" && b.kind === "assumable"));
});

test("a rising price curve is rejected as bad data rather than fitted", () => {
  const rising: Comparable[] = [
    comparable(10, 3.0),
    comparable(50, 4.0),
    comparable(100, 5.0),
    comparable(500, 8.0),
  ];
  const priced = priceFromCandidates(rising, 100);
  assert.notEqual(priced.method, "loglog_fit", "b > 0.05 must reject the fit");
  assert.equal(priced.method, "nearest_qty");
});

test("the persisted basis records the method and the quantity range used", () => {
  const priced = priceFromCandidates(CURVE, 300);
  assert.equal(priced.qtyRequested, 300);
  assert.equal(priced.qtyRangeMin, 10);
  assert.equal(priced.qtyRangeMax, 500);
  assert.equal(priced.comparableCount, 5);
  assert.ok(priced.fitSlope != null && priced.fitSlope < 0);
  assert.ok(priced.fitR2 != null && priced.fitR2 > 0.5);
});

test("nearest_qty never averages unit prices across different quantities", () => {
  // Two distinct quantities but only 3 comparables — below the loglog minimum.
  const thin: Comparable[] = [comparable(100, 4.4), comparable(100, 4.6), comparable(1000, 2.0)];
  const priced = priceFromCandidates(thin, 110);

  assert.equal(priced.method, "nearest_qty");
  // Must come from the qty-100 group only (4.4 / 4.6), never the qty-1000 row.
  assert.ok(priced.unitPrice! >= 4.4 && priced.unitPrice! <= 4.6);
});
