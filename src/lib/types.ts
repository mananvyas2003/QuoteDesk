export type ConfidenceState = "GREEN" | "AMBER" | "RED";

export type ExtractedFields = {
  description?: string;
  partNumber?: string;
  material?: string;
  finish?: string;
  tolerance?: string;
  revision?: string;
};

export type SourcePointer = {
  file: string;
  page?: number;
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

/** PRD §5.4 initial thresholds */
export const CONFIDENCE_THRESHOLDS = {
  minComparables: 3,
  maxAgeMonths: 12,
  maxVarianceCv: 0.15,
  nearMatchScore: 0.75,
  exactMatchScore: 0.92,
} as const;

export const EDIT_REASONS = [
  { code: "wrong_part", label: "Wrong part" },
  { code: "stale_price", label: "Stale price" },
  { code: "margin_too_thin", label: "Margin too thin" },
  { code: "wrong_qty_break", label: "Wrong quantity break" },
  { code: "customer_specific", label: "Customer-specific pricing" },
] as const;
