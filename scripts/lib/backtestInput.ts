import { readFileSync } from "node:fs";

/**
 * Parser for a shop's historical quote export. Format documented in
 * scripts/BACKTEST.md. Accepts CSV or JSON, snake_case or camelCase keys.
 */

export type InputLine = {
  quoteNumber: string;
  quotedAt: Date;
  accountName?: string;
  accountDomain?: string;
  partNumber?: string;
  description: string;
  material?: string;
  finish?: string;
  tolerance?: string;
  revision?: string;
  qty: number;
  unitPrice: number;
  sku?: string;
  specHash?: string;
  costIndex?: number;
  outcome?: string;
  competitorPrice?: number;
};

export type InputCost = {
  sku?: string;
  specHash?: string;
  unitCost: number;
  asOfDate: Date;
  source: string;
};

export type ParsedInput = { lines: InputLine[]; costs: InputCost[] };

export function loadInput(path: string, costsPath?: string): ParsedInput {
  const raw = readFileSync(path, "utf8");
  const isJson = path.toLowerCase().endsWith(".json") || raw.trimStart().startsWith("{") || raw.trimStart().startsWith("[");

  let lineRows: Record<string, string>[];
  let costRows: Record<string, string>[] = [];

  if (isJson) {
    const parsed = JSON.parse(raw) as unknown;
    const obj = Array.isArray(parsed) ? { lines: parsed } : (parsed as Record<string, unknown>);
    lineRows = (obj.lines as Record<string, string>[]) ?? [];
    costRows = (obj.costs as Record<string, string>[]) ?? [];
  } else {
    lineRows = parseCsv(raw);
  }

  if (costsPath) costRows = costRows.concat(parseCsvOrJson(costsPath));

  const lines = lineRows.map((r, i) => toLine(r, i));
  const costs = costRows.map((r, i) => toCost(r, i));
  return { lines, costs };
}

function parseCsvOrJson(path: string): Record<string, string>[] {
  const raw = readFileSync(path, "utf8");
  if (path.toLowerCase().endsWith(".json") || raw.trimStart().startsWith("[")) {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? (parsed as Record<string, string>[])
      : (((parsed as Record<string, unknown>).costs as Record<string, string>[]) ?? []);
  }
  return parseCsv(raw);
}

/** RFC4180-ish: quoted fields, doubled quotes, embedded commas and newlines. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim().length));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
    return o;
  });
}

/** Reads either `part_number` or `partNumber`. */
function pick(row: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = row[n];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return undefined;
}

function num(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function date(v: string | undefined, what: string, i: number): Date {
  const d = new Date(v ?? "");
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Row ${i + 1}: ${what} is missing or unparseable (got ${JSON.stringify(v)})`);
  }
  return d;
}

function toLine(row: Record<string, unknown>, i: number): InputLine {
  const qty = num(pick(row, "qty", "quantity"));
  const unitPrice = num(pick(row, "unit_price", "unitPrice", "price"));
  const description = pick(row, "description", "desc");
  const partNumber = pick(row, "part_number", "partNumber", "pn");

  if (qty == null || !(qty > 0)) {
    throw new Error(`Row ${i + 1}: qty is missing or not positive`);
  }
  if (unitPrice == null || !(unitPrice > 0)) {
    throw new Error(`Row ${i + 1}: unit_price is missing or not positive`);
  }
  if (!description && !partNumber) {
    throw new Error(`Row ${i + 1}: needs at least a description or a part_number`);
  }

  const outcome = pick(row, "outcome", "result")?.toLowerCase();
  if (outcome && !["won", "lost", "no_decision"].includes(outcome)) {
    throw new Error(
      `Row ${i + 1}: outcome must be won | lost | no_decision, got ${JSON.stringify(outcome)}`,
    );
  }

  return {
    quoteNumber: pick(row, "quote_number", "quoteNumber") ?? `ROW-${i + 1}`,
    quotedAt: date(pick(row, "quoted_at", "quotedAt", "date"), "quoted_at", i),
    accountName: pick(row, "account_name", "accountName", "customer"),
    accountDomain: pick(row, "account_domain", "accountDomain"),
    partNumber,
    description: description ?? partNumber!,
    material: pick(row, "material"),
    finish: pick(row, "finish"),
    tolerance: pick(row, "tolerance"),
    revision: pick(row, "revision", "rev"),
    qty,
    unitPrice,
    sku: pick(row, "sku"),
    specHash: pick(row, "spec_hash", "specHash"),
    costIndex: num(pick(row, "cost_index", "costIndex")),
    outcome,
    competitorPrice: num(pick(row, "competitor_price", "competitorPrice")),
  };
}

function toCost(row: Record<string, unknown>, i: number): InputCost {
  const unitCost = num(pick(row, "unit_cost", "unitCost", "cost"));
  if (unitCost == null || !(unitCost >= 0)) {
    throw new Error(`Cost row ${i + 1}: unit_cost is missing or negative`);
  }
  const source = pick(row, "source") ?? "manual";
  if (!["vendor_list", "manual", "erp_export"].includes(source)) {
    throw new Error(
      `Cost row ${i + 1}: source must be vendor_list | manual | erp_export, got ${JSON.stringify(source)}`,
    );
  }
  return {
    sku: pick(row, "sku"),
    specHash: pick(row, "spec_hash", "specHash"),
    unitCost,
    asOfDate: date(pick(row, "as_of_date", "asOfDate", "date"), "as_of_date", i),
    source,
  };
}
