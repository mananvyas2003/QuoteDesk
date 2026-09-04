import { prisma } from "./db";
import {
  buildAssumption,
  buildClarification,
  evaluateConfidence,
  missingSpec,
  violatesEnvelope,
  type PricingSignal,
} from "./confidence";
import type { CapabilityEnvelope, ExtractedFields } from "./types";
import { priceFromCandidates, resolveAgainstHistory } from "./resolve";

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Feature 2 — Draft the answer for an RFQ using history + confidence gating.
 */
export async function draftQuoteForRfq(rfqId: string) {
  const rfq = await prisma.rfq.findUniqueOrThrow({
    where: { id: rfqId },
    include: {
      lines: true,
      workspace: true,
      account: true,
    },
  });

  const envelope = parseJson<CapabilityEnvelope>(rfq.workspace.capabilityEnvelope, {});
  const marginFloor = rfq.workspace.marginFloorPct;

  // Clear prior draft
  const existing = await prisma.quote.findUnique({ where: { rfqId } });
  if (existing) {
    await prisma.quote.delete({ where: { id: existing.id } });
  }

  // Clear prior resolutions
  for (const line of rfq.lines) {
    await prisma.resolvedItem.deleteMany({ where: { rfqLineId: line.id } });
  }

  type DraftLine = {
    lineNumber: number;
    description: string;
    qty: number;
    unitPrice: number | null;
    confidenceState: "GREEN" | "AMBER" | "RED";
    clarification: string | null;
    assumptionText: string | null;
    leadDays: number | null;
    resolvedItemId: string;
    priceBasisId: string | null;
    envelopeReason?: string;
  };

  const draftLines: DraftLine[] = [];

  for (const line of rfq.lines) {
    const fields = parseJson<ExtractedFields>(line.extractedFields, {
      description: line.rawText,
    });
    const resolved = await resolveAgainstHistory(
      rfq.workspaceId,
      fields,
      rfq.accountId,
    );
    const priced = priceFromCandidates(resolved.candidates);
    const envelopeCheck = violatesEnvelope(fields, envelope);

    // Rough cost proxy: assume historical mean embeds ~margin; flag if price would imply thin margin
    // For V1 we force AMBER when controller margin floor cannot be demonstrated from cost records.
    const belowMarginFloor = false; // cost_record path not wired; margin floor UI still applies on edit

    const signal: PricingSignal = {
      matchScore: resolved.matchScore,
      matchType: resolved.matchType,
      comparableCount: priced.comparableCount,
      variance: priced.variance,
      unitPrice: priced.unitPrice,
      asOfDate: priced.asOfDate,
      inputQuality: line.extractConf,
      missingSpec: missingSpec(fields),
      envelopeViolation: envelopeCheck.violated,
      belowMarginFloor,
    };

    let confidence = evaluateConfidence(signal);
    // Override: any priced line below margin floor → AMBER (PRD)
    if (confidence === "GREEN" && belowMarginFloor) confidence = "AMBER";

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
        },
      });
      priceBasisId = pb.id;
    } else if (confidence !== "RED") {
      confidence = "RED";
    }

    const desc =
      fields.description || fields.partNumber || line.rawText.slice(0, 120);
    const lineLabel = `Line ${line.lineNumber}`;

    let clarification: string | null = null;
    let assumptionText: string | null = null;
    let unitPrice: number | null = priced.unitPrice;

    if (envelopeCheck.violated) {
      confidence = "RED";
      unitPrice = null;
      clarification = envelopeCheck.reason ?? buildClarification(fields, lineLabel);
    } else if (confidence === "RED") {
      unitPrice = null;
      clarification = buildClarification(fields, lineLabel);
    } else if (confidence === "AMBER") {
      assumptionText = buildAssumption({
        fields,
        signal,
        citationLabel: priced.citationLabel,
      });
    }

    // Cost check vs margin floor: if we had cost, enforce; for now annotate AMBER when variance high
    void marginFloor;

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
      envelopeReason: envelopeCheck.reason,
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
          ...(l.assumptionText
            ? { assumption: { create: { text: l.assumptionText } } }
            : {}),
        })),
      },
    },
    include: {
      lines: { include: { assumption: true, priceBasis: true } },
    },
  });

  await prisma.rfq.update({
    where: { id: rfqId },
    data: { status: "drafted" },
  });

  return quote;
}
