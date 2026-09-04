import {
  CONFIDENCE_THRESHOLDS,
  type CapabilityEnvelope,
  type ConfidenceState,
  type ExtractedFields,
} from "./types";

export type PricingSignal = {
  matchScore: number;
  matchType: string;
  comparableCount: number;
  variance: number | null;
  unitPrice: number | null;
  asOfDate: Date | null;
  inputQuality: number; // 0–1 extractConf
  missingSpec: boolean;
  envelopeViolation: boolean;
  belowMarginFloor: boolean;
};

export function evaluateConfidence(signal: PricingSignal): ConfidenceState {
  if (
    signal.envelopeViolation ||
    signal.matchType === "none" ||
    signal.unitPrice == null ||
    signal.comparableCount === 0
  ) {
    return "RED";
  }

  const ageOk =
    signal.asOfDate != null &&
    monthsBetween(signal.asOfDate, new Date()) <= CONFIDENCE_THRESHOLDS.maxAgeMonths;

  const green =
    signal.matchScore >= CONFIDENCE_THRESHOLDS.nearMatchScore &&
    signal.comparableCount >= CONFIDENCE_THRESHOLDS.minComparables &&
    ageOk &&
    (signal.variance == null || signal.variance <= CONFIDENCE_THRESHOLDS.maxVarianceCv) &&
    signal.inputQuality >= 0.7 &&
    !signal.missingSpec &&
    !signal.belowMarginFloor;

  if (green) return "GREEN";

  // Priced but needs assumption confirmation
  if (signal.unitPrice != null && signal.matchType !== "none") {
    return "AMBER";
  }

  return "RED";
}

export function missingSpec(fields: ExtractedFields): boolean {
  return !fields.material || !fields.finish;
}

export function violatesEnvelope(
  fields: ExtractedFields,
  envelope: CapabilityEnvelope,
): { violated: boolean; reason?: string } {
  if (fields.material && envelope.materials?.length) {
    const ok = envelope.materials.some(
      (m) => m.toLowerCase() === fields.material!.toLowerCase(),
    );
    if (!ok) {
      return {
        violated: true,
        reason: `Material ${fields.material} is outside our capability envelope.`,
      };
    }
  }
  if (fields.tolerance && envelope.toleranceClasses?.length) {
    const ok = envelope.toleranceClasses.some((t) =>
      fields.tolerance!.toLowerCase().includes(t.toLowerCase()),
    );
    if (!ok) {
      return {
        violated: true,
        reason: `Tolerance ${fields.tolerance} is outside our capability envelope.`,
      };
    }
  }
  return { violated: false };
}

export function buildAssumption(args: {
  fields: ExtractedFields;
  signal: PricingSignal;
  citationLabel?: string | null;
}): string {
  const parts: string[] = [];
  if (!args.fields.material) {
    parts.push("material is assumed to match prior jobs for this part family");
  }
  if (!args.fields.finish) {
    parts.push("finish is assumed mill / as-fabricated unless otherwise specified");
  }
  if (args.signal.comparableCount < CONFIDENCE_THRESHOLDS.minComparables) {
    parts.push(
      `pricing is based on ${args.signal.comparableCount} comparable${args.signal.comparableCount === 1 ? "" : "s"}${args.citationLabel ? ` (${args.citationLabel})` : ""}`,
    );
  }
  if (
    args.signal.variance != null &&
    args.signal.variance > CONFIDENCE_THRESHOLDS.maxVarianceCv
  ) {
    parts.push(
      `historical price variance is ${(args.signal.variance * 100).toFixed(0)}% CV; unit price may need review`,
    );
  }
  if (args.signal.belowMarginFloor) {
    parts.push("derived price sits at or below the configured margin floor");
  }
  if (args.signal.inputQuality < 0.7) {
    parts.push("source document quality is degraded; extracted specs should be verified");
  }
  if (parts.length === 0) {
    parts.push("pricing assumes continuity with the cited historical basis");
  }
  return `Assumes ${parts.join("; ")}.`;
}

export function buildClarification(fields: ExtractedFields, lineLabel: string): string {
  const gaps: string[] = [];
  if (!fields.material) gaps.push("material");
  if (!fields.finish) gaps.push("surface finish");
  if (!fields.revision && fields.partNumber) gaps.push("drawing revision");
  if (!fields.partNumber && !fields.description) gaps.push("part identification");
  if (gaps.length === 0) {
    return `${lineLabel}: we cannot resolve a price basis from history — please confirm the exact part/spec or prior quote reference.`;
  }
  return `${lineLabel}: please confirm ${gaps.join(", ")} so we can price this line.`;
}

function monthsBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return ms / (1000 * 60 * 60 * 24 * 30.44);
}
