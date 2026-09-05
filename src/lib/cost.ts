import { prisma } from "./db";

export type ResolvedCost = {
  unitCost: number;
  source: string;
  asOfDate: Date;
};

/**
 * Resolve a unit cost so margin can be checked against the workspace floor
 * (PRD §5.4). Matched on SKU first, then spec hash — most specific wins — and
 * the most recent record within a match wins.
 *
 * Returns null when nothing resolves. A null is not a zero cost and must never
 * be treated as one: the caller reports margin as unknown.
 */
export async function resolveCost(
  workspaceId: string,
  key: { sku?: string | null; specHash?: string | null },
): Promise<ResolvedCost | null> {
  const bySku = key.sku
    ? await prisma.costRecord.findFirst({
        where: { workspaceId, sku: key.sku },
        orderBy: { asOfDate: "desc" },
      })
    : null;

  const record =
    bySku ??
    (key.specHash
      ? await prisma.costRecord.findFirst({
          where: { workspaceId, specHash: key.specHash },
          orderBy: { asOfDate: "desc" },
        })
      : null);

  if (!record) return null;
  return { unitCost: record.unitCost, source: record.source, asOfDate: record.asOfDate };
}

/** (price − cost) / price, as a fraction. Null when either input is unusable. */
export function marginPct(unitPrice: number | null, unitCost: number | null): number | null {
  if (unitPrice == null || unitCost == null || unitPrice <= 0) return null;
  return (unitPrice - unitCost) / unitPrice;
}
