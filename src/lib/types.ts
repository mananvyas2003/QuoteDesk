export type ConfidenceState = "GREEN" | "AMBER" | "RED";

export type ExtractedFieldName =
  | "description"
  | "partNumber"
  | "material"
  | "finish"
  | "tolerance"
  | "revision";

export type ExtractedFields = {
  description?: string;
  partNumber?: string;
  material?: string;
  finish?: string;
  tolerance?: string;
  revision?: string;
  /**
   * PRD §5.1: "Must extract nothing it cannot cite back to a location in the
   * source document." One pointer per extracted field.
   */
  sources?: Partial<Record<ExtractedFieldName, SourcePointer>>;
};

export type SourcePointer = {
  file: string;
  page?: number;
  /** 1-indexed line offset within the source text, when the source is text. */
  line?: number;
  bbox?: [number, number, number, number];
  snippet?: string;
};

export type CapabilityEnvelope = {
  materials?: string[];
  maxSizeIn?: number;
  toleranceClasses?: string[];
  certifications?: string[];
  maxLeadDays?: number;
  minOrderValue?: number;
};

/**
 * Why a line is not GREEN.
 *
 * `unassumable` — the gap cannot be papered over with a stated assumption. The
 * line goes RED, is not priced, and generates a clarification question.
 *
 * `assumable` — the gap can be carried as a published assumption sentence the
 * estimator confirms. The line goes AMBER and is priced.
 *
 * Zero blockers is the only route to GREEN. This replaces the boolean
 * `missingSpec()`, which disagreed with `buildAssumption()` about whether a
 * missing finish was fatal or routine.
 */
export type BlockerKind = "unassumable" | "assumable";

export type Blocker = {
  code: string;
  kind: BlockerKind;
  detail: string;
};

export const BLOCKER_CODES = {
  // unassumable
  noResolvableItem: "no_resolvable_item",
  noPriceBasis: "no_price_basis",
  envelopeViolation: "envelope_violation",
  qtyConflict: "qty_conflict",
  unsupportableQuantity: "unsupportable_quantity",
  // assumable
  missingMaterial: "missing_material",
  missingFinish: "missing_finish",
  missingRevision: "missing_revision",
  weakMatch: "weak_match",
  singleComparable: "single_comparable",
  thinComparables: "thin_comparables",
  stalePriceBasis: "stale_price_basis",
  highVariance: "high_variance",
  degradedInput: "degraded_input",
  qtyExtrapolated: "qty_extrapolated",
  candidatePoolTruncated: "candidate_pool_truncated",
  noAccountHistory: "no_account_history",
  priorLossBelowPrice: "prior_loss_below_price",
  belowMarginFloor: "below_margin_floor",
  unknownMargin: "unknown_margin",
} as const;

/** How a unit price was derived from comparables. See src/lib/resolve.ts. */
export type PriceMethod =
  | "loglog_fit"
  | "nearest_qty"
  | "single_comparable"
  | "none";

export type CandidateScope = "account" | "workspace";

/** PRD §5.4 initial thresholds */
export const CONFIDENCE_THRESHOLDS = {
  minComparables: 3,
  maxAgeMonths: 12,
  maxVarianceCv: 0.15,
  nearMatchScore: 0.75,
  exactMatchScore: 0.92,
  /** Below this a candidate is not a comparable at all. */
  weakMatchScore: 0.35,
} as const;

export const EDIT_REASONS = [
  { code: "wrong_part", label: "Wrong part" },
  { code: "stale_price", label: "Stale price" },
  { code: "margin_too_thin", label: "Margin too thin" },
  { code: "wrong_qty_break", label: "Wrong quantity break" },
  { code: "customer_specific", label: "Customer-specific pricing" },
] as const;
