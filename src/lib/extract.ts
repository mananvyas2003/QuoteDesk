import type { ExtractedFields, SourcePointer } from "./types";

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
  const conflicts: string[] = [];
  const deadline = extractDeadline(body);
  const accountHint = extractAccountHint(body, input.fromEmail);

  const tableLines = extractTableLines(body, input.fileName ?? "paste.txt");
  const proseLines = tableLines.length
    ? []
    : extractProseLines(body, input.fileName ?? "paste.txt");

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

function extractTableLines(body: string, fileName: string): ParsedRfqLine[] {
  const lines: ParsedRfqLine[] = [];
  const rows = body.split(/\r?\n/);
  let lineNumber = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i].trim();
    if (!row || /^(item|line|qty|part|description)/i.test(row)) continue;

    // "PN | desc | qty | material"
    const pipe = row.split("|").map((c) => c.trim());
    if (pipe.length >= 3) {
      lineNumber += 1;
      const qty = parseFloat(pipe.find((c) => /^\d+(\.\d+)?$/.test(c)) ?? "1") || 1;
      const partNumber = pipe.find((c) => /^[A-Z0-9][A-Z0-9._-]{2,}$/i.test(c) && !/^\d+$/.test(c));
      const material = pipe.find((c) =>
        /steel|aluminum|alum|ss304|ss316|mild|carbon|plate|tube/i.test(c),
      );
      const description =
        pipe.find((c) => c.length > 8 && c !== partNumber && c !== material) ?? row;
      lines.push(
        makeLine({
          lineNumber,
          rawText: row,
          qty,
          fields: {
            description,
            partNumber,
            material,
            finish: undefined,
            revision: undefined,
          },
          fileName,
          page: 1,
          snippet: row,
          conf: 0.85,
        }),
      );
      continue;
    }

    // "100x Bracket PN-2041 A36"
    const qtyFirst = row.match(
      /^(\d+(?:\.\d+)?)\s*[x×]\s+(.+?)(?:\s+PN[:\s-]*([A-Z0-9._-]+))?(?:\s+(A36|A572|SS304|SS316|AL6061|Mild Steel|Aluminum))?$/i,
    );
    if (qtyFirst) {
      lineNumber += 1;
      lines.push(
        makeLine({
          lineNumber,
          rawText: row,
          qty: parseFloat(qtyFirst[1]),
          fields: {
            description: qtyFirst[2].trim(),
            partNumber: qtyFirst[3],
            material: qtyFirst[4],
          },
          fileName,
          page: 1,
          snippet: row,
          conf: 0.8,
        }),
      );
    }
  }

  return lines;
}

function extractProseLines(body: string, fileName: string): ParsedRfqLine[] {
  const lines: ParsedRfqLine[] = [];
  const sameAsQty = body.match(
    /same as\s+(?:PO|quote|Q)\s*#?\s*([A-Za-z0-9-]+).{0,40}?(\d+)\s*units?/i,
  );
  if (sameAsQty) {
    lines.push(
      makeLine({
        lineNumber: 1,
        rawText: sameAsQty[0],
        qty: parseFloat(sameAsQty[2]),
        fields: {
          description: `Same as ${sameAsQty[1]}`,
          partNumber: sameAsQty[1],
        },
        fileName,
        page: 1,
        snippet: sameAsQty[0],
        conf: 0.7,
      }),
    );
  }

  const itemMentions = [
    ...body.matchAll(
      /(?:need|quote|rfq|please price)\s+(\d+)\s+(?:pcs?|pieces?|units?)?\s*(?:of\s+)?([A-Za-z0-9][A-Za-z0-9 ._-]{3,60})/gi,
    ),
  ];
  for (const m of itemMentions) {
    lines.push(
      makeLine({
        lineNumber: lines.length + 1,
        rawText: m[0],
        qty: parseFloat(m[1]),
        fields: { description: m[2].trim() },
        fileName,
        page: 1,
        snippet: m[0],
        conf: 0.65,
      }),
    );
  }

  if (lines.length === 0 && body.length > 20) {
    lines.push(
      makeLine({
        lineNumber: 1,
        rawText: body.slice(0, 280),
        qty: 1,
        fields: { description: body.slice(0, 120).replace(/\s+/g, " ") },
        fileName,
        page: 1,
        snippet: body.slice(0, 160),
        conf: 0.4,
      }),
    );
  }

  return lines;
}

function makeLine(args: {
  lineNumber: number;
  rawText: string;
  qty: number;
  fields: ExtractedFields;
  fileName: string;
  page: number;
  snippet: string;
  conf: number;
}): ParsedRfqLine {
  const qtyBreaks = extractQtyBreaks(args.rawText);
  return {
    lineNumber: args.lineNumber,
    rawText: args.rawText,
    qty: args.qty,
    qtyBreaks,
    extractedFields: args.fields,
    sourcePtr: {
      file: args.fileName,
      page: args.page,
      snippet: args.snippet,
    },
    extractConf: args.conf,
  };
}

function extractQtyBreaks(text: string): number[] {
  const m = text.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
  if (!m) return [];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}
