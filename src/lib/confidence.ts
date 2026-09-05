import {
  BLOCKER_CODES,
  CONFIDENCE_THRESHOLDS,
  type Blocker,
  type CapabilityEnvelope,
  type ConfidenceState,
  type ExtractedFields,
} from "./types";

export type EnvelopeCheck = { violated: boolean; reason?: string };

export type MarginSignal = {
  /** Whether a cost record resolved for this item. */
  costKnown: boolean;
  /** (price − cost) / price, as a fraction. Null when cost is unknown. */
  marginPct: number | null;
  /** Workspace margin floor, as a fraction. */
  floorPct: number;
  /** PRD §5.4 + Task 6: unknown margin must not silently pass as GREEN. */
  requireCostForGreen: boolean;
};

export type PricingSignal = {
  fields: ExtractedFields;
  matchScore: number;
  matchType: string;
  comparableCount: number;
  variance: number | null;
  unitPrice: number | null;
  asOfDate: Date | null;
  /** 0–1 extractConf */
  inputQuality: number;
  envelope: EnvelopeCheck;
  /** Blockers raised upstream: extraction conflicts, retrieval, quantity. */
  extraBlockers?: Blocker[];
  margin?: MarginSignal;
  /** Injectable clock, for deterministic tests. */
  now?: Date;
};

/**
 * PRD §5.4. A line is GREEN only when nothing blocks it.
 *
 * This replaces the old boolean `missingSpec()`, which made a missing finish
 * disqualifying for GREEN while `buildAssumption()` treated the same gap as a
 * routine assumption. Blockers are now classified once, and both the gate and
 * the assumption text read the same list, so they cannot disagree.
 */
export function evaluateConfidence(signal: PricingSignal): {
  state: ConfidenceState;
  blockers: Blocker[];
} {
  const blockers: Blocker[] = [...(signal.extraBlockers ?? [])];
  const now = signal.now ?? new Date();
  const f = signal.fields;

  // ---- unassumable ----------------------------------------------------
  if (signal.envelope.violated) {
    blockers.push({
      code: BLOCKER_CODES.envelopeViolation,
      kind: "unassumable",
      detail: signal.envelope.reason ?? "the request falls outside our capability envelope",
    });
  }
  if (signal.matchType === "none") {
    blockers.push({
      code: BLOCKER_CODES.noResolvableItem,
      kind: "unassumable",
      detail: "no item in quote history resolves against this line",
    });
  }
  if (signal.unitPrice == null || signal.comparableCount === 0) {
    blockers.push({
      code: BLOCKER_CODES.noPriceBasis,
      kind: "unassumable",
      detail: "no priced comparable is available as a price basis",
    });
  }

  // ---- assumable ------------------------------------------------------
  if (signal.matchType === "weak") {
    blockers.push({
      code: BLOCKER_CODES.weakMatch,
      kind: "assumable",
      detail: `the resolved item is a weak match (score ${signal.matchScore.toFixed(2)}) and should be confirmed`,
    });
  }
  if (!f.material) {
    blockers.push({
      code: BLOCKER_CODES.missingMaterial,
      kind: "assumable",
      detail: "material is assumed to match prior jobs for this part family",
    });
  }
  if (!f.finish) {
    blockers.push({
      code: BLOCKER_CODES.missingFinish,
      kind: "assumable",
      detail: "finish is assumed mill / as-fabricated unless otherwise specified",
    });
  }
  if (f.partNumber && !f.revision) {
    blockers.push({
      code: BLOCKER_CODES.missingRevision,
      kind: "assumable",
      detail: `drawing revision for ${f.partNumber} is unstated; pricing assumes the revision last quoted`,
    });
  }
  if (signal.comparableCount === 1) {
    blockers.push({
      code: BLOCKER_CODES.singleComparable,
      kind: "assumable",
      detail: "pricing is based on a single comparable",
    });
  } else if (
    signal.comparableCount > 1 &&
    signal.comparableCount < CONFIDENCE_THRESHOLDS.minComparables
  ) {
    blockers.push({
      code: BLOCKER_CODES.thinComparables,
      kind: "assumable",
      detail: `pricing is based on ${signal.comparableCount} comparables, below the ${CONFIDENCE_THRESHOLDS.minComparables} we treat as sufficient`,
    });
  }
  if (signal.unitPrice != null && signal.comparableCount > 0) {
    const ageMonths =
      signal.asOfDate == null ? null : monthsBetween(signal.asOfDate, now);
    if (ageMonths == null || ageMonths > CONFIDENCE_THRESHOLDS.maxAgeMonths) {
      blockers.push({
        code: BLOCKER_CODES.stalePriceBasis,
        kind: "assumable",
        detail:
          ageMonths == null
            ? "the price basis has no date"
            : `the price basis is ${ageMonths.toFixed(0)} months old, beyond the ${CONFIDENCE_THRESHOLDS.maxAgeMonths}-month window`,
      });
    }
  }
  if (signal.variance != null && signal.variance > CONFIDENCE_THRESHOLDS.maxVarianceCv) {
    blockers.push({
      code: BLOCKER_CODES.highVariance,
      kind: "assumable",
      detail: `historical price variance is ${(signal.variance * 100).toFixed(0)}% CV; unit price may need review`,
    });
  }
  if (signal.inputQuality < 0.7) {
    blockers.push({
      code: BLOCKER_CODES.degradedInput,
      kind: "assumable",
      detail: "source document quality is degraded; extracted specs should be verified",
    });
  }

  // ---- margin (PRD §5.4 override rule) --------------------------------
  if (signal.margin) {
    const m = signal.margin;
    if (m.costKnown && m.marginPct != null && m.marginPct <= m.floorPct) {
      blockers.push({
        code: BLOCKER_CODES.belowMarginFloor,
        kind: "assumable",
        detail: `the derived price yields ${(m.marginPct * 100).toFixed(1)}% margin, at or below the ${(m.floorPct * 100).toFixed(0)}% floor`,
      });
    }
    if (!m.costKnown && m.requireCostForGreen) {
      blockers.push({
        code: BLOCKER_CODES.unknownMargin,
        kind: "assumable",
        detail: "no cost record resolves for this item, so margin cannot be verified against the floor",
      });
    }
  }

  const deduped = dedupe(blockers);
  if (deduped.some((b) => b.kind === "unassumable")) return { state: "RED", blockers: deduped };
  if (deduped.length) return { state: "AMBER", blockers: deduped };
  return { state: "GREEN", blockers: deduped };
}

function dedupe(blockers: Blocker[]): Blocker[] {
  const seen = new Set<string>();
  return blockers.filter((b) => {
    if (seen.has(b.code)) return false;
    seen.add(b.code);
    return true;
  });
}

export function violatesEnvelope(
  fields: ExtractedFields,
  envelope: CapabilityEnvelope,
): EnvelopeCheck {
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

/**
 * The assumption sentence published into the quote (PRD §5.2b).
 * Built from the assumable blockers, not re-derived from fields, so it can
 * never state something the gate did not act on.
 */
export function buildAssumption(args: {
  blockers: Blocker[];
  citationLabel?: string | null;
}): string {
  const parts = args.blockers.filter((b) => b.kind === "assumable").map((b) => b.detail);
  if (parts.length === 0) {
    parts.push("pricing assumes continuity with the cited historical basis");
  }
  const citation = args.citationLabel ? ` Basis: ${args.citationLabel}.` : "";
  return `Assumes ${parts.join("; ")}.${citation}`;
}

/** The clarification question for a RED line (PRD §5.2, "never a guessed price"). */
export function buildClarification(args: {
  blockers: Blocker[];
  fields: ExtractedFields;
  lineLabel: string;
}): string {
  const hard = args.blockers.filter((b) => b.kind === "unassumable");
  const envelope = hard.find((b) => b.code === BLOCKER_CODES.envelopeViolation);
  if (envelope) return `${args.lineLabel}: ${envelope.detail}`;

  const conflict = hard.find((b) => b.code === BLOCKER_CODES.qtyConflict);
  if (conflict) return `${args.lineLabel}: ${conflict.detail}`;

  const qty = hard.find((b) => b.code === BLOCKER_CODES.unsupportableQuantity);
  if (qty) return `${args.lineLabel}: ${qty.detail}`;

  const gaps: string[] = [];
  const f = args.fields;
  if (!f.partNumber && !f.description) gaps.push("part identification");
  if (!f.material) gaps.push("material");
  if (!f.finish) gaps.push("surface finish");
  if (!f.revision && f.partNumber) gaps.push("drawing revision");

  if (gaps.length === 0) {
    return `${args.lineLabel}: we cannot resolve a price basis from history — please confirm the exact part/spec or prior quote reference.`;
  }
  return `${args.lineLabel}: please confirm ${gaps.join(", ")} so we can price this line.`;
}

export function monthsBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return ms / (1000 * 60 * 60 * 24 * 30.44);
}
