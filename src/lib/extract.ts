import {
  extractHeaderSpecs,
  findFinish,
  findMaterial,
  findRevision,
  findTolerance,
  pointer,
  type HeaderSpecs,
  type SpecHit,
} from "./specs";
import type { ExtractedFieldName, ExtractedFields, SourcePointer } from "./types";

export type ParsedRfqLine = {
  lineNumber: number;
  rawText: string;
  qty: number;
  qtyBreaks: number[];
  extractedFields: ExtractedFields;
  sourcePtr: SourcePointer;
  extractConf: number;
};

export type ParsedRfq = {
  subject?: string;
  fromEmail?: string;
  fromName?: string;
  accountHint?: string;
  deadline?: Date;
  body: string;
  lines: ParsedRfqLine[];
  conflicts: string[];
};

/**
 * Deterministic RFQ parser for V1.
 * Handles email-like paste and simple line tables.
 * Multimodal / OCR path can replace extractLines later while keeping source pointers.
 */
export function parseRfqInput(input: {
  subject?: string;
  fromEmail?: string;
  fromName?: string;
  body: string;
  fileName?: string;
}): ParsedRfq {
  const body = input.body.trim();
  const fileName = input.fileName ?? "paste.txt";
  const conflicts: string[] = [];
  const deadline = extractDeadline(body);
  const accountHint = extractAccountHint(body, input.fromEmail);
  const header = extractHeaderSpecs(body);

  const tableLines = extractTableLines(body, fileName, header);
  const proseLines = tableLines.length ? [] : extractProseLines(body, fileName, header);

  // Conflict: body qty vs "same as PO" style note
  const sameAs = body.match(/same as\s+(?:PO|quote|Q)\s*#?\s*([A-Za-z0-9-]+)/i);
  if (sameAs && (tableLines.length || proseLines.length)) {
    conflicts.push(
      `Body references prior order/quote ${sameAs[1]}; confirm line table matches that job.`,
    );
  }

  return {
    subject: input.subject,
    fromEmail: input.fromEmail,
    fromName: input.fromName,
    accountHint,
    deadline,
    body,
    lines: tableLines.length ? tableLines : proseLines,
    conflicts,
  };
}

function extractDeadline(body: string): Date | undefined {
  const m =
    body.match(/quote\s+by[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i) ||
    body.match(/need\s+(?:pricing|quote)\s+by[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i) ||
    body.match(/deadline[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
  if (!m) return undefined;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function extractAccountHint(body: string, fromEmail?: string): string | undefined {
  if (fromEmail) {
    const domain = fromEmail.split("@")[1];
    if (domain) return domain.split(".")[0];
  }
  const m = body.match(/(?:from|account|company)[:\s]+([A-Za-z0-9 .&-]{2,40})/i);
  return m?.[1]?.trim();
}

const PART_NUMBER_CELL = /^[A-Z0-9][A-Z0-9._\/-]{2,}$/i;
const PURE_NUMBER = /^\d+(\.\d+)?$/;

/** A cell is a material cell only when the *whole* cell is a known material. */
function wholeCellMaterial(cell: string): SpecHit | undefined {
  const hit = findMaterial(cell);
  if (!hit) return undefined;
  return hit.snippet.trim().length >= cell.trim().length - 1 ? hit : undefined;
}

function extractTableLines(
  body: string,
  fileName: string,
  header: HeaderSpecs,
): ParsedRfqLine[] {
  const lines: ParsedRfqLine[] = [];
  const rows = body.split(/\r?\n/);
  let lineNumber = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i].trim();
    if (!row || /^(item|line|qty|part|description)\b/i.test(row)) continue;

    // "PN | desc | qty | material"
    const cells = row.split("|").map((c) => c.trim());
    if (cells.length >= 3) {
      lineNumber += 1;
      const qty = parseFloat(cells.find((c) => PURE_NUMBER.test(c)) ?? "1") || 1;

      const materialCell = cells.find((c) => wholeCellMaterial(c));
      const partNumber = cells.find(
        (c) => c !== materialCell && !PURE_NUMBER.test(c) && PART_NUMBER_CELL.test(c),
      );
      const description =
        cells
          .filter((c) => c !== materialCell && c !== partNumber && !PURE_NUMBER.test(c))
          .sort((a, b) => b.length - a.length)[0] ?? row;

      // A material may also be stated only inside the description cell.
      const material =
        (materialCell ? wholeCellMaterial(materialCell) : undefined) ??
        findMaterial(description);

      lines.push(
        makeLine({
          lineNumber,
          rawText: row,
          qty,
          fileName,
          sourceLine: i + 1,
          snippet: row,
          conf: 0.85,
          base: { description, partNumber },
          baseSnippets: { description, partNumber },
          specText: row,
          material,
          header,
        }),
      );
      continue;
    }

    // "100x Bracket PN-2041 A36"
    const qtyFirst = row.match(
      /^(\d+(?:\.\d+)?)\s*[x×]\s+(.+?)(?:\s+P\/?N[:\s-]*([A-Z0-9][A-Z0-9._\/-]*))?(?:\s+(A36|A572|SS304|SS316|AL6061|Mild Steel|Aluminum))?$/i,
    );
    if (qtyFirst) {
      lineNumber += 1;
      const description = qtyFirst[2].trim();
      lines.push(
        makeLine({
          lineNumber,
          rawText: row,
          qty: parseFloat(qtyFirst[1]),
          fileName,
          sourceLine: i + 1,
          snippet: row,
          conf: 0.8,
          base: { description, partNumber: qtyFirst[3] },
          baseSnippets: { description, partNumber: qtyFirst[3] },
          specText: row,
          material: qtyFirst[4]
            ? { value: qtyFirst[4], snippet: qtyFirst[4] }
            : findMaterial(row),
          header,
        }),
      );
    }
  }

  return lines;
}

const PN_IN_PROSE = /\bP\/?N[:\s-]*([A-Z0-9][A-Z0-9._\/-]{2,})/i;

function extractProseLines(
  body: string,
  fileName: string,
  header: HeaderSpecs,
): ParsedRfqLine[] {
  const lines: ParsedRfqLine[] = [];
  const rows = body.split(/\r?\n/);
  /** Find the source row containing an offset, so specs can be read from it. */
  const rowAt = (index: number): { text: string; line: number } => {
    let cursor = 0;
    for (let i = 0; i < rows.length; i++) {
      const end = cursor + rows[i].length;
      if (index <= end) return { text: rows[i], line: i + 1 };
      cursor = end + 1;
    }
    return { text: body, line: 1 };
  };

  const sameAsQty = body.match(
    /same as\s+((?:PO|quote|Q)\s*#?\s*[A-Za-z0-9-]+).{0,40}?(\d+)\s*units?/i,
  );
  if (sameAsQty) {
    const at = rowAt(sameAsQty.index ?? 0);
    lines.push(
      makeLine({
        lineNumber: 1,
        rawText: sameAsQty[0],
        qty: parseFloat(sameAsQty[2]),
        fileName,
        sourceLine: at.line,
        snippet: sameAsQty[0],
        conf: 0.7,
        base: {
          description: `Same as ${normalizeRef(sameAsQty[1])}`,
          partNumber: normalizeRef(sameAsQty[1]),
        },
        baseSnippets: { description: sameAsQty[0], partNumber: sameAsQty[1] },
        specText: at.text,
        material: findMaterial(at.text),
        header,
      }),
    );
  }

  const itemMentions = [
    ...body.matchAll(
      /(?:need|quote|rfq|please price)\s+(\d+)\s+(?:pcs?|pieces?|units?)?\s*(?:of\s+)?([A-Za-z0-9][A-Za-z0-9 ._-]{3,60})/gi,
    ),
  ];
  for (const m of itemMentions) {
    const at = rowAt(m.index ?? 0);
    const description = m[2].trim();
    lines.push(
      makeLine({
        lineNumber: lines.length + 1,
        rawText: m[0],
        qty: parseFloat(m[1]),
        fileName,
        sourceLine: at.line,
        snippet: m[0],
        conf: 0.65,
        base: {
          description,
          partNumber: at.text.match(PN_IN_PROSE)?.[1],
        },
        baseSnippets: {
          description,
          partNumber: at.text.match(PN_IN_PROSE)?.[0],
        },
        specText: at.text,
        material: findMaterial(description) ?? findMaterial(at.text),
        header,
      }),
    );
  }

  if (lines.length === 0 && body.length > 20) {
    lines.push(
      makeLine({
        lineNumber: 1,
        rawText: body.slice(0, 280),
        qty: 1,
        fileName,
        sourceLine: 1,
        snippet: body.slice(0, 160),
        conf: 0.4,
        base: { description: body.slice(0, 120).replace(/\s+/g, " ") },
        baseSnippets: { description: body.slice(0, 120).replace(/\s+/g, " ") },
        specText: body,
        material: findMaterial(body),
        header,
      }),
    );
  }

  return lines;
}

/** "PO 4471" / "PO-4471" / "Q #4412" all normalise to the stored quote number form. */
function normalizeRef(raw: string): string {
  const m = raw.match(/^(PO|quote|Q)\s*#?\s*-?\s*([A-Za-z0-9-]+)$/i);
  if (!m) return raw.trim();
  const prefix = m[1].toLowerCase() === "quote" ? "Q" : m[1].toUpperCase();
  return `${prefix}-${m[2]}`;
}

function makeLine(args: {
  lineNumber: number;
  rawText: string;
  qty: number;
  fileName: string;
  sourceLine: number;
  snippet: string;
  conf: number;
  base: { description?: string; partNumber?: string };
  baseSnippets: { description?: string; partNumber?: string };
  /** Text searched for line-level finish / tolerance / revision. */
  specText: string;
  material?: SpecHit;
  header: HeaderSpecs;
}): ParsedRfqLine {
  const sources: Partial<Record<ExtractedFieldName, SourcePointer>> = {};
  const linePtr = (snippet: string) =>
    pointer({ file: args.fileName, line: args.sourceLine, snippet });
  const headerPtr = (hit: { snippet: string; line: number }) =>
    pointer({ file: args.fileName, line: hit.line, snippet: hit.snippet });

  const fields: ExtractedFields = {};

  if (args.base.description) {
    fields.description = args.base.description;
    sources.description = linePtr(args.baseSnippets.description ?? args.base.description);
  }
  if (args.base.partNumber) {
    fields.partNumber = args.base.partNumber;
    sources.partNumber = linePtr(args.baseSnippets.partNumber ?? args.base.partNumber);
  }

  // Line-level spec wins; document header / title block is the fallback.
  const material = args.material;
  if (material) {
    fields.material = material.value;
    sources.material = linePtr(material.snippet);
  } else if (args.header.material) {
    fields.material = args.header.material.value;
    sources.material = headerPtr(args.header.material);
  }

  assignSpec(fields, sources, "finish", findFinish(args.specText), args.header.finish, linePtr, headerPtr);
  assignSpec(fields, sources, "tolerance", findTolerance(args.specText), args.header.tolerance, linePtr, headerPtr);
  assignSpec(fields, sources, "revision", findRevision(args.specText), args.header.revision, linePtr, headerPtr);

  if (Object.keys(sources).length) fields.sources = sources;

  return {
    lineNumber: args.lineNumber,
    rawText: args.rawText,
    qty: args.qty,
    qtyBreaks: extractQtyBreaks(args.rawText),
    extractedFields: fields,
    sourcePtr: pointer({ file: args.fileName, line: args.sourceLine, snippet: args.snippet }),
    extractConf: args.conf,
  };
}

function assignSpec(
  fields: ExtractedFields,
  sources: Partial<Record<ExtractedFieldName, SourcePointer>>,
  field: "finish" | "tolerance" | "revision",
  lineHit: SpecHit | undefined,
  headerHit: (SpecHit & { line: number }) | undefined,
  linePtr: (snippet: string) => SourcePointer,
  headerPtr: (hit: { snippet: string; line: number }) => SourcePointer,
): void {
  if (lineHit) {
    fields[field] = lineHit.value;
    sources[field] = linePtr(lineHit.snippet);
  } else if (headerHit) {
    fields[field] = headerHit.value;
    sources[field] = headerPtr(headerHit);
  }
}

function extractQtyBreaks(text: string): number[] {
  const m = text.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
  if (!m) return [];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}
