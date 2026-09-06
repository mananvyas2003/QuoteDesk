import type { ExtractedFieldName } from "../types";

/**
 * How a document has to be read.
 *
 * `pdf` and `image` both go to the multimodal path — a scanned print has no
 * text layer at all, so there is nothing deterministic to parse. The split
 * exists because the API takes them as different content blocks, not because
 * they are treated differently afterwards.
 */
export type DocumentKind = "pdf" | "image";

export type ExtractableDocument = {
  fileName: string;
  mimeType: string;
  kind: DocumentKind;
  /** Bytes, base64-encoded, as the API takes them. */
  contentBase64: string;
  size: number;
};

/** Where in the document a value was read from. PRD §5.1. */
export type DocumentCitation = {
  page?: number;
  snippet?: string;
  /** Normalised [x0, y0, x1, y1] in 0–1 page coordinates, when reported. */
  bbox?: [number, number, number, number];
};

/**
 * One quotable line read out of a document.
 *
 * Every field is optional because the extractor is required to omit anything it
 * cannot read, rather than guess. An omitted material becomes a
 * `missing_material` blocker downstream through the existing gate — which is
 * the correct outcome and needs no new blocker code.
 */
export type DocumentLine = {
  qty?: number;
  qtyBreaks?: number[];
  description?: string;
  partNumber?: string;
  material?: string;
  finish?: string;
  tolerance?: string;
  revision?: string;
  /** 0–1 per field. Below `MIN_FIELD_CONFIDENCE` the field is discarded. */
  fieldConfidence?: Partial<Record<ExtractedFieldName, number>>;
  citations?: Partial<Record<ExtractedFieldName, DocumentCitation>>;
  /** 0–1 for the line as a whole. */
  confidence: number;
  page?: number;
  snippet?: string;
};

export type DocumentExtraction = {
  fileName: string;
  lines: DocumentLine[];
  /** Why nothing was read, when `lines` is empty. Shown to the estimator. */
  note?: string;
  /**
   * True when no extractor could open the document at all — a distinct case
   * from "opened it and found no quotable lines", which is a real answer.
   */
  unreadable: boolean;
};
