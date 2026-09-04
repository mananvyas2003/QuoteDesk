import { prisma } from "./db";
import { monthsBetween } from "./confidence";
import { PRICING_CONFIG, recencyWeight } from "./pricing";
import {
  BLOCKER_CODES,
  CONFIDENCE_THRESHOLDS,
  type Blocker,
  type CandidateScope,
  type ExtractedFields,
  type PriceMethod,
} from "./types";

export type Comparable = {
  id: string;
  description: string;
  partNumber: string | null;
  sku: string | null;
  qty: number;
  unitPrice: number;
  quotedAt: Date;
  scope: CandidateScope;
  outcome: string | null;
  competitorPrice: number | null;
  costIndex: number | null;
};

export type ResolveResult = {
  sku: string | null;
  specHash: string | null;
  matchType: "exact" | "near" | "weak" | "historical_ref" | "none";
  matchScore: number;
  candidates: Comparable[];
  blockers: Blocker[];
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(normalize(a).split(" ").filter(Boolean));
  const tb = new Set(normalize(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.max(ta.size, tb.size);
}

export function specHash(fields: ExtractedFields): string {
  return [
    fields.partNumber ?? "",
    fields.material ?? "",
    fields.finish ?? "",
    fields.tolerance ?? "",
    fields.revision ?? "",
    normalize(fields.description ?? "").slice(0, 80),
  ]
    .join("|")
    .toLowerCase();
}

export async function resolveAgainstHistory(
  workspaceId: string,
  fields: ExtractedFields,
  accountId?: string | null,
): Promise<ResolveResult> {
  const history = await prisma.historicalQuoteLine.findMany({
    where: { historicalQuote: { workspaceId, ...(accountId ? { accountId } : {}) } },
    include: { historicalQuote: true },
    take: 500,
  });

  const toComparable = (h: (typeof history)[number]): Comparable => ({
    id: h.id,
    description: h.description,
    partNumber: h.partNumber,
    sku: h.sku,
    qty: h.qty,
    unitPrice: h.unitPrice,
    quotedAt: h.historicalQuote.quotedAt,
    scope: accountId ? "account" : "workspace",
    outcome: null,
    competitorPrice: null,
    costIndex: null,
  });

  // "same as PO/quote X"
  const refMatch = fields.partNumber || fields.description?.match(/same as\s+(\S+)/i)?.[1];
  if (refMatch) {
    const byQuote = history.filter(
      (h) =>
        h.historicalQuote.quoteNumber?.toLowerCase() === refMatch.toLowerCase() ||
        h.partNumber?.toLowerCase() === refMatch.toLowerCase(),
    );
    if (byQuote.length) {
      return {
        sku: byQuote[0].sku,
        specHash: byQuote[0].specHash ?? specHash(fields),
        matchType: "historical_ref",
        matchScore: 0.9,
        candidates: byQuote.map(toComparable),
        blockers: [],
      };
    }
  }

  const scored = history
    .map((h) => {
      let score = 0;
      if (
        fields.partNumber &&
        h.partNumber &&
        fields.partNumber.toLowerCase() === h.partNumber.toLowerCase()
      ) {
        score = 0.98;
      } else {
        score = tokenOverlap(fields.description ?? "", h.description);
        if (
          fields.material &&
          h.material &&
          fields.material.toLowerCase() === h.material.toLowerCase()
        ) {
          score = Math.min(1, score + 0.15);
        }
      }
      return { h, score };
    })
    .filter((x) => x.score >= CONFIDENCE_THRESHOLDS.weakMatchScore)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return {
      sku: null,
      specHash: specHash(fields),
      matchType: "none",
      matchScore: 0,
      candidates: [],
      blockers: [],
    };
  }

  const best = scored[0];
  return {
    sku: best.h.sku,
    specHash: best.h.specHash ?? specHash(fields),
    matchType: classifyMatch(best.score),
    matchScore: best.score,
    candidates: scored.slice(0, PRICING_CONFIG.retrieval.scoredPoolCap).map(({ h }) => toComparable(h)),
    blockers: [],
  };
}

/**
 * The one place the exact / near / weak boundary is decided. The previous
 * ternary assigned "near" in both branches and was then overwritten by a second
 * comparison, so the exact tier was dead code.
 */
export function classifyMatch(score: number): "exact" | "near" | "weak" | "none" {
  if (score >= CONFIDENCE_THRESHOLDS.exactMatchScore) return "exact";
  if (score >= CONFIDENCE_THRESHOLDS.nearMatchScore) return "near";
  if (score >= CONFIDENCE_THRESHOLDS.weakMatchScore) return "weak";
  return "none";
}

export type PricedResult = {
  unitPrice: number | null;
  method: PriceMethod;
  asOfDate: Date | null;
  comparableCount: number;
  variance: number | null;
  sourceId: string | null;
  citationLabel: string | null;
  qtyRequested: number;
  qtyRangeMin: number | null;
  qtyRangeMax: number | null;
  fitSlope: number | null;
  fitR2: number | null;
  blockers: Blocker[];
};

type Weighted = { c: Comparable; weight: number; price: number };

/**
 * Derive a unit price for a *specific requested quantity*.
 *
 * In fabrication, unit price versus quantity is the dominant curve because
 * setup cost amortises. The previous implementation returned the arithmetic
 * mean of comparable unit prices with no quantity normalisation, so a price at
 * qty 10 averaged with one at qty 1000 was wrong for both. That path is gone:
 * unit prices are never averaged across different quantities.
 */
export function priceFromCandidates(
  candidates: Comparable[],
  qtyRequested: number,
  opts?: { now?: Date; currentCostIndex?: number | null },
): PricedResult {
  const now = opts?.now ?? new Date();
  const blockers: Blocker[] = [];

  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - CONFIDENCE_THRESHOLDS.maxAgeMonths);
  const recent = candidates.filter((c) => c.quotedAt >= cutoff);
  const pool = recent.length ? recent : candidates;

  const empty: PricedResult = {
    unitPrice: null,
    method: "none",
    asOfDate: null,
    comparableCount: 0,
    variance: null,
    sourceId: null,
    citationLabel: null,
    qtyRequested,
    qtyRangeMin: null,
    qtyRangeMax: null,
    fitSlope: null,
    fitR2: null,
    blockers,
  };

  if (!pool.length) {
    blockers.push({
      code: BLOCKER_CODES.noPriceBasis,
      kind: "unassumable",
      detail: "no priced comparable is available as a price basis",
    });
    return empty;
  }

  const qtyRangeMin = Math.min(...pool.map((c) => c.qty));
  const qtyRangeMax = Math.max(...pool.map((c) => c.qty));

  // How far outside the observed quantity range is the request?
  const outsideRatio =
    qtyRequested > qtyRangeMax
      ? qtyRequested / qtyRangeMax
      : qtyRequested < qtyRangeMin
        ? qtyRangeMin / qtyRequested
        : 1;

  if (outsideRatio > PRICING_CONFIG.qty.extrapolationRedRatio) {
    blockers.push({
      code: BLOCKER_CODES.unsupportableQuantity,
      kind: "unassumable",
      detail: `quantity ${fmtQty(qtyRequested)} is ${outsideRatio.toFixed(0)}× outside the ${fmtQty(qtyRangeMin)}–${fmtQty(qtyRangeMax)} range we have priced; we will not extrapolate a setup-cost curve that far`,
    });
    return { ...empty, comparableCount: pool.length, qtyRangeMin, qtyRangeMax };
  }
  if (outsideRatio > PRICING_CONFIG.qty.extrapolationAmberRatio) {
    blockers.push({
      code: BLOCKER_CODES.qtyExtrapolated,
      kind: "assumable",
      detail: `quantity ${fmtQty(qtyRequested)} is ${outsideRatio.toFixed(1)}× outside the ${fmtQty(qtyRangeMin)}–${fmtQty(qtyRangeMax)} range of our comparables; the unit price is extrapolated`,
    });
  }

  const weighted: Weighted[] = pool.map((c) => ({
    c,
    weight: comparableWeight(c, now),
    price: adjustedPrice(c, opts?.currentCostIndex ?? null),
  }));

  const base = { qtyRequested, qtyRangeMin, qtyRangeMax, blockers };

  // 3. Single comparable.
  if (weighted.length === 1) {
    const only = weighted[0];
    blockers.push({
      code: BLOCKER_CODES.singleComparable,
      kind: "assumable",
      detail: `pricing is based on a single comparable at quantity ${fmtQty(only.c.qty)}`,
    });
    return {
      ...base,
      unitPrice: round(only.price),
      method: "single_comparable",
      asOfDate: only.c.quotedAt,
      comparableCount: 1,
      variance: null,
      sourceId: only.c.id,
      citationLabel: citation(only.c),
      fitSlope: null,
      fitR2: null,
    };
  }

  // 1. Log-log fit, when there is enough quantity spread to see a curve.
  const distinctQty = new Set(pool.map((c) => c.qty));
  const spread = qtyRangeMax / qtyRangeMin;
  if (
    weighted.length >= PRICING_CONFIG.qty.minComparablesForFit &&
    distinctQty.size >= 2 &&
    spread >= PRICING_CONFIG.qty.minQtyRatioForFit
  ) {
    const fit = logLogFit(weighted);
    if (
      fit &&
      fit.slope <= PRICING_CONFIG.qty.maxAcceptedSlope &&
      fit.r2 >= PRICING_CONFIG.qty.minAcceptedR2
    ) {
      const price = Math.exp(fit.intercept + fit.slope * Math.log(qtyRequested));
      const newest = newestOf(pool);
      return {
        ...base,
        unitPrice: round(price),
        method: "loglog_fit",
        asOfDate: newest.quotedAt,
        comparableCount: pool.length,
        variance: fit.residualCv,
        sourceId: newest.id,
        citationLabel: citation(newest),
        fitSlope: fit.slope,
        fitR2: fit.r2,
      };
    }
  }

  // 2. Nearest quantity. Only comparables at that same quantity contribute, so
  //    unit prices are never averaged across different quantities.
  const targetLog = Math.log(qtyRequested);
  const nearestQty = weighted.reduce((best, w) =>
    Math.abs(Math.log(w.c.qty) - targetLog) < Math.abs(Math.log(best.c.qty) - targetLog)
      ? w
      : best,
  ).c.qty;
  const group = weighted.filter((w) => w.c.qty === nearestQty);
  const price = weightedMean(group);
  const newest = newestOf(group.map((w) => w.c));

  if (group.length === 1) {
    blockers.push({
      code: BLOCKER_CODES.singleComparable,
      kind: "assumable",
      detail: `pricing is based on a single comparable at quantity ${fmtQty(nearestQty)}, nearest to the requested ${fmtQty(qtyRequested)}`,
    });
  } else if (group.length < CONFIDENCE_THRESHOLDS.minComparables) {
    blockers.push({
      code: BLOCKER_CODES.thinComparables,
      kind: "assumable",
      detail: `pricing is based on ${group.length} comparables at quantity ${fmtQty(nearestQty)}, nearest to the requested ${fmtQty(qtyRequested)}`,
    });
  }

  return {
    ...base,
    unitPrice: round(price),
    method: "nearest_qty",
    asOfDate: newest.quotedAt,
    comparableCount: group.length,
    variance: group.length > 1 ? weightedCv(group, price) : null,
    sourceId: newest.id,
    citationLabel: citation(newest),
    fitSlope: null,
    fitR2: null,
  };
}

/** Outcome × recency × scope. Tasks 3b, 4 and 5. */
export function comparableWeight(c: Comparable, now: Date): number {
  const scope = PRICING_CONFIG.scopeWeights[c.scope] ?? 1;
  const recency = recencyWeight(
    monthsBetween(c.quotedAt, now),
    PRICING_CONFIG.recencyHalfLifeMonths,
  );
  const outcome = PRICING_CONFIG.outcomeWeights[c.outcome ?? "unknown"] ?? 1;
  return Math.max(scope * recency * outcome, 1e-6);
}

/**
 * Back-adjust a historical price by a material cost index when the shop has
 * supplied one. When either index is missing, do not adjust and do not invent
 * an index.
 */
function adjustedPrice(c: Comparable, currentCostIndex: number | null): number {
  if (currentCostIndex == null || c.costIndex == null || c.costIndex <= 0) return c.unitPrice;
  return c.unitPrice * (currentCostIndex / c.costIndex);
}

function logLogFit(
  points: Weighted[],
): { slope: number; intercept: number; r2: number; residualCv: number } | null {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) {
    if (p.price <= 0 || p.c.qty <= 0) return null;
    const x = Math.log(p.c.qty);
    const y = Math.log(p.price);
    sw += p.weight;
    sx += p.weight * x;
    sy += p.weight * y;
    sxx += p.weight * x * x;
    sxy += p.weight * x * y;
  }
  const denom = sw * sxx - sx * sx;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) return null;

  const slope = (sw * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / sw;

  const ybar = sy / sw;
  let ssRes = 0, ssTot = 0, ratioSum = 0, ratioWeight = 0;
  for (const p of points) {
    const x = Math.log(p.c.qty);
    const y = Math.log(p.price);
    const yhat = intercept + slope * x;
    ssRes += p.weight * (y - yhat) ** 2;
    ssTot += p.weight * (y - ybar) ** 2;
    ratioSum += p.weight * (p.price / Math.exp(yhat));
    ratioWeight += p.weight;
  }
  const r2 = ssTot <= 1e-12 ? 0 : 1 - ssRes / ssTot;

  // Dispersion around the fitted curve, expressed as a CV so it can be compared
  // against the same 15% threshold as a flat comparable set.
  const meanRatio = ratioSum / ratioWeight;
  let varSum = 0;
  for (const p of points) {
    const yhat = intercept + slope * Math.log(p.c.qty);
    varSum += p.weight * (p.price / Math.exp(yhat) - meanRatio) ** 2;
  }
  const residualCv = meanRatio > 0 ? Math.sqrt(varSum / ratioWeight) / meanRatio : null;

  return { slope, intercept, r2, residualCv: residualCv ?? 0 };
}

function weightedMean(points: Weighted[]): number {
  const w = points.reduce((s, p) => s + p.weight, 0);
  return points.reduce((s, p) => s + p.weight * p.price, 0) / w;
}

function weightedCv(points: Weighted[], mean: number): number | null {
  if (mean <= 0) return null;
  const w = points.reduce((s, p) => s + p.weight, 0);
  const v = points.reduce((s, p) => s + p.weight * (p.price - mean) ** 2, 0) / w;
  return Math.sqrt(v) / mean;
}

function newestOf(cs: Comparable[]): Comparable {
  return [...cs].sort((a, b) => b.quotedAt.getTime() - a.quotedAt.getTime())[0];
}

function citation(c: Comparable): string {
  return `${c.partNumber ?? c.description.slice(0, 40)} @ $${c.unitPrice.toFixed(2)} × ${fmtQty(c.qty)} (${c.quotedAt.toISOString().slice(0, 10)})`;
}

function fmtQty(q: number): string {
  return Number.isInteger(q) ? q.toLocaleString("en-US") : q.toFixed(2);
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
