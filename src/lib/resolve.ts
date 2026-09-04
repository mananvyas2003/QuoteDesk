import { prisma } from "./db";
import { CONFIDENCE_THRESHOLDS, type ExtractedFields } from "./types";

export type ResolveResult = {
  sku: string | null;
  specHash: string | null;
  matchType: "exact" | "near" | "historical_ref" | "none";
  matchScore: number;
  candidates: Array<{
    id: string;
    description: string;
    partNumber: string | null;
    unitPrice: number;
    quotedAt: Date;
    sku: string | null;
  }>;
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
    where: {
      historicalQuote: {
        workspaceId,
        ...(accountId ? { accountId } : {}),
      },
    },
    include: { historicalQuote: true },
    take: 500,
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
        candidates: byQuote.map((h) => ({
          id: h.id,
          description: h.description,
          partNumber: h.partNumber,
          unitPrice: h.unitPrice,
          quotedAt: h.historicalQuote.quotedAt,
          sku: h.sku,
        })),
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
    .filter((x) => x.score >= 0.35)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return {
      sku: null,
      specHash: specHash(fields),
      matchType: "none",
      matchScore: 0,
      candidates: [],
    };
  }

  const best = scored[0];
  const matchType =
    best.score >= CONFIDENCE_THRESHOLDS.exactMatchScore
      ? "exact"
      : best.score >= CONFIDENCE_THRESHOLDS.nearMatchScore
        ? "near"
        : "near";

  return {
    sku: best.h.sku,
    specHash: best.h.specHash ?? specHash(fields),
    matchType: best.score < CONFIDENCE_THRESHOLDS.nearMatchScore ? "near" : matchType,
    matchScore: best.score,
    candidates: scored.slice(0, 12).map(({ h }) => ({
      id: h.id,
      description: h.description,
      partNumber: h.partNumber,
      unitPrice: h.unitPrice,
      quotedAt: h.historicalQuote.quotedAt,
      sku: h.sku,
    })),
  };
}

export function priceFromCandidates(candidates: ResolveResult["candidates"]): {
  unitPrice: number | null;
  asOfDate: Date | null;
  comparableCount: number;
  variance: number | null;
  sourceId: string | null;
  citationLabel: string | null;
} {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - CONFIDENCE_THRESHOLDS.maxAgeMonths);
  const recent = candidates.filter((c) => c.quotedAt >= cutoff);
  const pool = recent.length ? recent : candidates;
  if (!pool.length) {
    return {
      unitPrice: null,
      asOfDate: null,
      comparableCount: 0,
      variance: null,
      sourceId: null,
      citationLabel: null,
    };
  }

  const prices = pool.map((c) => c.unitPrice);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance =
    prices.length > 1
      ? Math.sqrt(
          prices.reduce((a, p) => a + (p - mean) ** 2, 0) / prices.length,
        ) / mean
      : 0;

  const newest = [...pool].sort((a, b) => b.quotedAt.getTime() - a.quotedAt.getTime())[0];

  return {
    unitPrice: mean,
    asOfDate: newest.quotedAt,
    comparableCount: pool.length,
    variance,
    sourceId: newest.id,
    citationLabel: `${newest.partNumber ?? newest.description.slice(0, 40)} @ $${newest.unitPrice.toFixed(2)} (${newest.quotedAt.toISOString().slice(0, 10)})`,
  };
}
