import { prisma } from "./db";
import {
  buildAssumption,
  buildClarification,
  evaluateConfidence,
  violatesEnvelope,
} from "./confidence";
import type {
  Blocker,
  CapabilityEnvelope,
  ConfidenceState,
  ExtractedFields,
} from "./types";
import { priceFromCandidates, resolveAgainstHistory, type PricedResult } from "./resolve";
import { marginPct, resolveCost } from "./cost";

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const STATE_RANK: Record<ConfidenceState, number> = { GREEN: 0, AMBER: 1, RED: 2 };

function worst(a: ConfidenceState, b: ConfidenceState): ConfidenceState {
  return STATE_RANK[a] >= STATE_RANK[b] ? a : b;
}

export type BreakPricing = {
  qty: number;
  unitPrice: number | null;
  method: string;
  confidenceState: ConfidenceState;
  blockerCodes: string[];
};

/**
 * Feature 2 — Draft the answer for an RFQ using history + confidence gating.
 */
export async function draftQuoteForRfq(rfqId: string) {
  const rfq = await prisma.rfq.findUniqueOrThrow({
    where: { id: rfqId },
    include: { lines: true, workspace: true, account: true },
  });

  const envelope = parseJson<CapabilityEnvelope>(rfq.workspace.capabilityEnvelope, {});

  // Clear prior draft
  const existing = await prisma.quote.findUnique({ where: { rfqId } });
  if (existing) await prisma.quote.delete({ where: { id: existing.id } });
  for (const line of rfq.lines) {
    await prisma.resolvedItem.deleteMany({ where: { rfqLineId: line.id } });
  }

  type DraftLine = {
    lineNumber: number;
    description: string;
    qty: number;
    unitPrice: number | null;
    confidenceState: ConfidenceState;
    clarification: string | null;
    assumptionText: string | null;
    leadDays: number | null;
    resolvedItemId: string;
    priceBasisId: string | null;
    marginPct: number | null;
    qtyBreakPricing: BreakPricing[];
    envelopeReason?: string;
  };

  const draftLines: DraftLine[] = [];

  for (const line of rfq.lines) {
    const fields = parseJson<ExtractedFields>(line.extractedFields, {
      description: line.rawText,
    });
    const qtyBreaks = parseJson<number[]>(line.qtyBreaks, []);
    const extractionBlockers = parseJson<Blocker[]>(line.extractionBlockers, []);
    const resolved = await resolveAgainstHistory(rfq.workspaceId, fields, rfq.accountId);
    const envelopeCheck = violatesEnvelope(fields, envelope);

    // PRD §5.4 override rule. Previously hard-coded to false with the comment
    // "cost_record path not wired", which made the check that gets a pilot
    // approved a no-op.
    const cost = await resolveCost(rfq.workspaceId, {
      sku: resolved.sku,
      specHash: resolved.specHash,
    });
    const floorPct = rfq.workspace.marginFloorPct / 100;

    /** Price and gate one requested quantity through the production path. */
    const at = (qty: number) => {
      const priced = priceFromCandidates(resolved.candidates, qty, {
        currentCostIndex: resolved.currentCostIndex,
      });
      const evaluated = evaluateConfidence({
        fields,
        matchScore: resolved.matchScore,
        matchType: resolved.matchType,
        comparableCount: priced.comparableCount,
        variance: priced.variance,
        unitPrice: priced.unitPrice,
        asOfDate: priced.asOfDate,
        inputQuality: line.extractConf,
        envelope: envelopeCheck,
        extraBlockers: [...extractionBlockers, ...resolved.blockers, ...priced.blockers],
        margin: {
          costKnown: cost != null,
          marginPct: marginPct(priced.unitPrice, cost?.unitCost ?? null),
          floorPct,
          requireCostForGreen: rfq.workspace.requireCostForGreen,
        },
      });
      return { priced, ...evaluated };
    };

    const primary = at(line.qty);

    // Each requested break is priced independently through the same path; the
    // line takes the worst state of all of them (PRD §5.2 quantity breaks).
    const evaluatedBreaks = qtyBreaks
      .filter((q) => q !== line.qty)
      .map((q) => ({ qty: q, ...at(q) }));

    const breaks: BreakPricing[] = evaluatedBreaks.map((r) => ({
      qty: r.qty,
      unitPrice: r.state === "RED" ? null : r.priced.unitPrice,
      method: r.priced.method,
      confidenceState: r.state,
      blockerCodes: r.blockers.map((b) => b.code),
    }));

    let confidence = breaks.reduce((s, b) => worst(s, b.confidenceState), primary.state);

    // When a break is what dragged the line down, the reason has to travel with
    // it — otherwise the line is RED with a clarification that never mentions
    // the quantity that caused it.
    let blockers: Blocker[] = [
      ...primary.blockers,
      ...evaluatedBreaks
        .filter((r) => STATE_RANK[r.state] > STATE_RANK[primary.state])
        .flatMap((r) =>
          r.blockers
            .filter((b) => !primary.blockers.some((p) => p.code === b.code))
            .map((b) => ({ ...b, detail: `at quantity ${r.qty.toLocaleString()}, ${b.detail}` })),
        ),
    ];
    const priced: PricedResult = primary.priced;

    const resolvedItem = await prisma.resolvedItem.create({
      data: {
        rfqLineId: line.id,
        sku: resolved.sku,
        specHash: resolved.specHash,
        matchType: resolved.matchType,
        matchScore: resolved.matchScore,
      },
    });

    let priceBasisId: string | null = null;
    if (priced.unitPrice != null && !envelopeCheck.violated && resolved.matchType !== "none") {
      const pb = await prisma.priceBasis.create({
        data: {
          resolvedItemId: resolvedItem.id,
          sourceType: "historical_quote",
          sourceId: priced.sourceId,
          unitPrice: priced.unitPrice,
          asOfDate: priced.asOfDate,
          comparableCount: priced.comparableCount,
          variance: priced.variance,
          citationLabel: priced.citationLabel,
          method: priced.method,
          qtyRequested: priced.qtyRequested,
          qtyRangeMin: priced.qtyRangeMin,
          qtyRangeMax: priced.qtyRangeMax,
          fitSlope: priced.fitSlope,
          fitR2: priced.fitR2,
        },
      });
      priceBasisId = pb.id;
    } else if (confidence !== "RED") {
      confidence = "RED";
      blockers = [
        ...blockers,
        {
          code: "no_price_basis",
          kind: "unassumable",
          detail: "no priced comparable is available as a price basis",
        },
      ];
    }

    const desc = fields.description || fields.partNumber || line.rawText.slice(0, 120);
    const lineLabel = `Line ${line.lineNumber}`;

    let clarification: string | null = null;
    let assumptionText: string | null = null;
    let unitPrice: number | null = priced.unitPrice;

    if (confidence === "RED") {
      unitPrice = null;
      clarification = buildClarification({ blockers, fields, lineLabel });
    } else if (confidence === "AMBER") {
      assumptionText = buildAssumption({ blockers, citationLabel: priced.citationLabel });
    }

    draftLines.push({
      lineNumber: line.lineNumber,
      description: desc,
      qty: line.qty,
      unitPrice,
      confidenceState: confidence,
      clarification,
      assumptionText,
      leadDays: confidence === "RED" ? null : 14,
      resolvedItemId: resolvedItem.id,
      priceBasisId,
      marginPct: marginPct(unitPrice, cost?.unitCost ?? null),
      qtyBreakPricing: breaks,
      envelopeReason: envelopeCheck.violated ? envelopeCheck.reason : undefined,
    });
  }

  const hasAmber = draftLines.some((l) => l.confidenceState === "AMBER");
  const allRed = draftLines.length > 0 && draftLines.every((l) => l.confidenceState === "RED");
  const anyEnvelope = draftLines.some((l) => l.envelopeReason);

  let answerType: "priced" | "priced_with_assumptions" | "decline" | "clarify";
  let declineReason: string | null = null;

  if (anyEnvelope && allRed) {
    answerType = "decline";
    declineReason = draftLines.map((l) => l.envelopeReason).filter(Boolean).join(" ");
  } else if (allRed) {
    answerType = "clarify";
  } else if (hasAmber) {
    answerType = "priced_with_assumptions";
  } else {
    answerType = "priced";
  }

  const pricedLines = draftLines.filter((l) => l.unitPrice != null);
  const total = pricedLines.reduce((s, l) => s + (l.unitPrice ?? 0) * l.qty, 0);

  // Quote margin is the value-weighted margin of the lines whose cost is known.
  const costed = pricedLines.filter((l) => l.marginPct != null);
  const costedValue = costed.reduce((s, l) => s + (l.unitPrice ?? 0) * l.qty, 0);
  const quoteMarginPct = costedValue
    ? costed.reduce((s, l) => s + l.marginPct! * (l.unitPrice ?? 0) * l.qty, 0) / costedValue
    : null;

  const quote = await prisma.quote.create({
    data: {
      rfqId,
      answerType,
      total: pricedLines.length ? total : null,
      marginPct: quoteMarginPct,
      declineReason,
      lines: {
        create: draftLines.map((l) => ({
          lineNumber: l.lineNumber,
          description: l.description,
          qty: l.qty,
          unitPrice: l.unitPrice,
          confidenceState: l.confidenceState,
          clarification: l.clarification,
          leadDays: l.leadDays,
          resolvedItemId: l.resolvedItemId,
          priceBasisId: l.priceBasisId,
          marginPct: l.marginPct,
          qtyBreakPricing: JSON.stringify(l.qtyBreakPricing),
          ...(l.assumptionText
            ? { assumption: { create: { text: l.assumptionText } } }
            : {}),
        })),
      },
    },
    include: { lines: { include: { assumption: true, priceBasis: true } } },
  });

  await prisma.rfq.update({ where: { id: rfqId }, data: { status: "drafted" } });

  return quote;
}
