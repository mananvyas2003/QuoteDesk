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
    qtyBreakPricing: BreakPricing[];
    envelopeReason?: string;
  };

  const draftLines: DraftLine[] = [];

  for (const line of rfq.lines) {
    const fields = parseJson<ExtractedFields>(line.extractedFields, {
      description: line.rawText,
    });
    const qtyBreaks = parseJson<number[]>(line.qtyBreaks, []);
    const resolved = await resolveAgainstHistory(rfq.workspaceId, fields, rfq.accountId);
    const envelopeCheck = violatesEnvelope(fields, envelope);

    /** Price and gate one requested quantity through the production path. */
    const at = (qty: number) => {
      const priced = priceFromCandidates(resolved.candidates, qty);
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
        extraBlockers: [...resolved.blockers, ...priced.blockers],
      });
      return { priced, ...evaluated };
    };

    const primary = at(line.qty);

    // Each requested break is priced independently through the same path; the
    // line takes the worst state of all of them (PRD §5.2 quantity breaks).
    const breaks: BreakPricing[] = qtyBreaks
      .filter((q) => q !== line.qty)
      .map((q) => {
        const r = at(q);
        return {
          qty: q,
          unitPrice: r.state === "RED" ? null : r.priced.unitPrice,
          method: r.priced.method,
          confidenceState: r.state,
          blockerCodes: r.blockers.map((b) => b.code),
        };
      });

    let confidence = breaks.reduce((s, b) => worst(s, b.confidenceState), primary.state);
    let blockers: Blocker[] = primary.blockers;
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

  const quote = await prisma.quote.create({
    data: {
      rfqId,
      answerType,
      total: pricedLines.length ? total : null,
      marginPct: null,
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
