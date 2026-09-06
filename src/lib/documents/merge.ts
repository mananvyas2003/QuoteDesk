import type { ParsedRfq, ParsedRfqLine } from "../extract";
import {
  BLOCKER_CODES,
  type Blocker,
  type ExtractedFieldName,
  type ExtractedFields,
  type SourcePointer,
} from "../types";
import type { DocumentExtraction, DocumentLine } from "./types";

/**
 * Legibility thresholds for document extraction.
 *
 * These are **not** confidence-gate thresholds and they are deliberately not in
 * `CONFIDENCE_THRESHOLDS`. They decide only whether a value was read clearly
 * enough to be treated as stated — upstream of every pricing decision. They are
 * unvalidated defaults, chosen conservatively: a dropped field costs an AMBER
 * line with a published assumption, whereas a wrongly-kept field costs a GREEN
 * line that is silently wrong. The asymmetry sets the direction of every guess
 * here.
 */
export const EXTRACTION_CONFIDENCE = {
  /** Below this, the field is discarded rather than carried as read. */
  minField: 0.6,
  /** Below this, the line carries the existing `degraded_input` blocker. */
  minLine: 0.5,
} as const;

const FIELD_NAMES: ExtractedFieldName[] = [
  "description",
  "partNumber",
  "material",
  "finish",
  "tolerance",
  "revision",
];

/**
 * Fold what the attachments said into what the email body said.
 *
 * The common shape of a real RFQ is that the body carries the ask and the
 * quantity ("20 off, PN-4471, need it in three weeks") while the drawing
 * carries the specification (material, finish, tolerance, revision in the title
 * block). Neither alone is enough to reach GREEN. So a document line that
 * matches a body line **enriches** it rather than duplicating it, and only an
 * unmatched document line becomes a new line.
 *
 * Enrichment never overwrites. A value stated in the body was written by the
 * buyer directly; a value read off a drawing was read by a model. Where they
 * both speak, the body wins, and where they disagree about quantity the
 * existing `qty_conflict` blocker fires and the line goes RED — the same
 * treatment the text parser already gives a body that contradicts itself.
 */
export function applyDocumentExtractions(
  parsed: ParsedRfq,
  extractions: DocumentExtraction[],
  skipped: Array<{ fileName: string; reason: string }> = [],
): ParsedRfq {
  const lines = parsed.lines.map((l) => cloneLine(l));
  const conflicts = [...parsed.conflicts];

  for (const extraction of extractions) {
    for (const docLine of extraction.lines) {
      const usable = withLowConfidenceFieldsDropped(docLine);
      if (!hasAnyContent(usable)) continue;

      const match = findMatch(lines, usable);
      if (match) {
        enrich(match, usable, extraction.fileName, conflicts);
      } else {
        lines.push(toParsedLine(usable, extraction.fileName, lines.length + 1));
      }
    }

    if (extraction.note) {
      conflicts.push(`${extraction.fileName}: ${extraction.note}`);
    }
  }

  // Attachments we could not open are stated, never silently ignored. An
  // estimator who is told "assembly.dxf was not read" knows to open it; silence
  // looks like the file was understood.
  for (const s of skipped) {
    conflicts.push(`${s.fileName} was not read (${s.reason}).`);
  }

  return {
    ...parsed,
    lines: lines.map((l, i) => ({ ...l, lineNumber: i + 1 })),
    conflicts,
  };
}

/**
 * A field the model was unsure it read correctly is dropped, not kept.
 *
 * Dropping it is what makes the existing gate do the right thing without a new
 * blocker code: an absent material raises `missing_material`, the line becomes
 * AMBER, and the assumption sentence says which material was assumed. A kept
 * low-confidence material would instead have produced a confidently wrong GREEN.
 */
function withLowConfidenceFieldsDropped(line: DocumentLine): DocumentLine {
  const out: DocumentLine = { ...line };
  for (const name of FIELD_NAMES) {
    const conf = line.fieldConfidence?.[name];
    if (conf !== undefined && conf < EXTRACTION_CONFIDENCE.minField) {
      delete out[name];
    }
  }
  return out;
}

function hasAnyContent(line: DocumentLine): boolean {
  return FIELD_NAMES.some((n) => line[n] != null) || line.qty != null;
}

/**
 * Match a document line to a body line.
 *
 * Part number is the reliable key; description similarity is the fallback and
 * is deliberately strict (one string containing the other), because a wrong
 * match silently attaches one part's material to another part's line.
 */
function findMatch(
  lines: ParsedRfqLine[],
  doc: DocumentLine,
): ParsedRfqLine | undefined {
  const docPn = normalize(doc.partNumber);
  if (docPn) {
    const byPn = lines.find(
      (l) => normalize(l.extractedFields.partNumber) === docPn,
    );
    if (byPn) return byPn;
  }

  const docDesc = normalize(doc.description);
  if (!docDesc || docDesc.length < 6) return undefined;
  return lines.find((l) => {
    const d = normalize(l.extractedFields.description);
    if (!d || d.length < 6) return false;
    return d.includes(docDesc) || docDesc.includes(d);
  });
}

function enrich(
  target: ParsedRfqLine,
  doc: DocumentLine,
  fileName: string,
  conflicts: string[],
): void {
  const fields = target.extractedFields;
  const sources: Partial<Record<ExtractedFieldName, SourcePointer>> = {
    ...(fields.sources ?? {}),
  };

  let added = false;
  for (const name of FIELD_NAMES) {
    const value = doc[name];
    if (value == null) continue;
    if (fields[name] != null) continue; // the body already said it; it wins
    fields[name] = value;
    sources[name] = citationPointer(doc, name, fileName);
    added = true;
  }
  if (added) fields.sources = sources;

  // A drawing that states a different quantity than the email is exactly the
  // ambiguity the estimator must resolve; we cannot pick one.
  if (doc.qty != null && doc.qty !== target.qty) {
    const label = target.extractedFields.partNumber ?? `line ${target.lineNumber}`;
    pushBlocker(target, {
      code: BLOCKER_CODES.qtyConflict,
      kind: "unassumable",
      detail: `the email asks for ${target.qty.toLocaleString()} but ${fileName} states ${doc.qty.toLocaleString()}; we cannot tell which quantity applies`,
    });
    conflicts.push(
      `${label}: email quantity ${target.qty.toLocaleString()} disagrees with ${fileName} (${doc.qty.toLocaleString()}); confirm which applies.`,
    );
  }

  if (doc.qtyBreaks?.length && !target.qtyBreaks.length) {
    target.qtyBreaks = [...doc.qtyBreaks];
  }

  if (added && doc.confidence < EXTRACTION_CONFIDENCE.minLine) {
    pushBlocker(target, degradedInput(fileName, doc));
  }
}

function toParsedLine(
  doc: DocumentLine,
  fileName: string,
  lineNumber: number,
): ParsedRfqLine {
  const fields: ExtractedFields = {};
  const sources: Partial<Record<ExtractedFieldName, SourcePointer>> = {};

  for (const name of FIELD_NAMES) {
    const value = doc[name];
    if (value == null) continue;
    fields[name] = value;
    sources[name] = citationPointer(doc, name, fileName);
  }
  if (Object.keys(sources).length) fields.sources = sources;

  const blockers: Blocker[] = [];
  if (doc.confidence < EXTRACTION_CONFIDENCE.minLine) {
    blockers.push(degradedInput(fileName, doc));
  }

  return {
    lineNumber,
    rawText: doc.snippet ?? doc.description ?? doc.partNumber ?? fileName,
    // A drawing that states no quantity is quoting a single piece until the
    // buyer says otherwise; assuming a larger run would understate unit price.
    qty: doc.qty ?? 1,
    qtyBreaks: doc.qtyBreaks ? [...doc.qtyBreaks] : [],
    extractedFields: fields,
    sourcePtr: {
      file: fileName,
      page: doc.page ?? 1,
      snippet: doc.snippet,
    },
    extractConf: doc.confidence,
    blockers,
  };
}

function degradedInput(fileName: string, doc: DocumentLine): Blocker {
  return {
    code: BLOCKER_CODES.degradedInput,
    kind: "assumable",
    detail: `read from ${fileName} at low legibility (${doc.confidence.toFixed(
      2,
    )}); the specification should be confirmed against the drawing`,
  };
}

function citationPointer(
  doc: DocumentLine,
  name: ExtractedFieldName,
  fileName: string,
): SourcePointer {
  const c = doc.citations?.[name];
  return {
    file: fileName,
    page: c?.page ?? doc.page ?? 1,
    bbox: c?.bbox,
    snippet: c?.snippet ?? doc.snippet,
  };
}

function pushBlocker(line: ParsedRfqLine, blocker: Blocker): void {
  if (line.blockers.some((b) => b.code === blocker.code)) return;
  line.blockers.push(blocker);
}

function cloneLine(l: ParsedRfqLine): ParsedRfqLine {
  return {
    ...l,
    qtyBreaks: [...l.qtyBreaks],
    blockers: [...l.blockers],
    extractedFields: {
      ...l.extractedFields,
      sources: l.extractedFields.sources ? { ...l.extractedFields.sources } : undefined,
    },
  };
}

function normalize(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
