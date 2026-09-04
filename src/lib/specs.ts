import type { ExtractedFieldName, SourcePointer } from "./types";

/**
 * Spec recognisers shared by every extraction path.
 *
 * PRD §5.1 requires material, finish, tolerance and revision to be extracted,
 * and §5.4 makes a missing finish or revision an AMBER assumption rather than a
 * silent GREEN. Before this module existed nothing in the codebase ever
 * assigned a finish, a tolerance or a revision, which made GREEN unreachable.
 *
 * Every recogniser returns the matched text so the caller can cite it back to a
 * location in the source.
 */

export type SpecHit = { value: string; snippet: string };

/**
 * Materials are matched against a known vocabulary rather than a loose keyword
 * regex. The previous `/steel|plate|tube/` matcher assigned the *description*
 * cell ("Base plate 12x18x0.5") as the material, dropping the real material and
 * tripping the capability-envelope check.
 */
const MATERIAL_ALIASES: Array<{ canonical: string; pattern: RegExp }> = [
  { canonical: "A36", pattern: /\bA[\s-]?36\b/i },
  { canonical: "A572", pattern: /\bA[\s-]?572(?:[\s-]?gr(?:ade)?[\s.]?50)?\b/i },
  { canonical: "A514", pattern: /\bA[\s-]?514\b/i },
  { canonical: "A1011", pattern: /\bA[\s-]?1011\b/i },
  { canonical: "SS304", pattern: /\b(?:SS[\s-]?304|304[\s-]?SS|304L?\s+stainless)\b/i },
  { canonical: "SS316", pattern: /\b(?:SS[\s-]?316|316[\s-]?SS|316L?\s+stainless)\b/i },
  { canonical: "AL6061", pattern: /\b(?:AL[\s-]?6061|6061[\s-]?T6|6061)\b/i },
  { canonical: "AL5052", pattern: /\b(?:AL[\s-]?5052|5052)\b/i },
  { canonical: "Ti-6Al-4V", pattern: /\b(?:Ti[\s-]?6Al[\s-]?4V|titanium)\b/i },
  { canonical: "Mild Steel", pattern: /\bmild\s+steel\b/i },
  { canonical: "Carbon Steel", pattern: /\bcarbon\s+steel\b/i },
  { canonical: "Stainless", pattern: /\bstainless(?:\s+steel)?\b/i },
  { canonical: "Aluminum", pattern: /\balumin(?:i)?um\b/i },
  { canonical: "Galvanized Steel", pattern: /\bgalvani[sz]ed\s+steel\b/i },
];

const FINISH_PATTERNS: Array<{ pattern: RegExp; normalize?: (m: RegExpMatchArray) => string }> = [
  {
    pattern: /\bpowder[\s-]?coat(?:ed|ing)?(?:\s+(?:in\s+)?(black|white|blue|red|grey|gray|green|yellow|silver|clear|RAL\s*\d{4}))?\b/i,
    normalize: (m) => (m[1] ? `powder coat ${m[1].toLowerCase()}` : "powder coat"),
  },
  { pattern: /\bas[\s-]?fabricated\b/i, normalize: () => "as-fabricated" },
  { pattern: /\bmill\s*(?:finish)?\b/i, normalize: () => "mill" },
  { pattern: /\bprimer(?:ed)?\b|\bprimed\b/i, normalize: () => "primer" },
  { pattern: /\bpassivat(?:e|ed|ion)\b/i, normalize: () => "passivate" },
  { pattern: /\banodi[sz](?:e|ed|ing)\b/i, normalize: () => "anodize" },
  { pattern: /\bhot[\s-]?dip\s+galvani[sz]ed\b/i, normalize: () => "hot-dip galvanized" },
  { pattern: /\bgalvani[sz]ed\b/i, normalize: () => "galvanized" },
  { pattern: /\bzinc[\s-]?plate(?:d)?\b/i, normalize: () => "zinc plate" },
  { pattern: /\bpaint(?:ed)?\b/i, normalize: () => "painted" },
];

const ISO_TOLERANCE = /\bISO\s*2768\s*[-–\s]\s*([mfcv])\b/i;
const SYMBOLIC_TOLERANCE = /(?:±|\+\/-|\+-|\+\s*\/\s*-)\s*(\d+\/\d+|\d*\.\d+|\d+(?:\.\d+)?)/;

const REVISION_PATTERNS: Array<{ pattern: RegExp; normalize: (m: RegExpMatchArray) => string }> = [
  // "Rev C", "REV. B", "Revision C", "Rev-R3"
  {
    pattern: /\brev(?:ision)?\.?\s*[-:]?\s*(R?\d{1,3}|[A-Z])\b/i,
    normalize: (m) => `Rev ${m[1].toUpperCase()}`,
  },
  // Bare "-R3" suffix on a drawing or part number
  {
    pattern: /(?:^|[\s(,])-R(\d{1,3})\b/i,
    normalize: (m) => `Rev R${m[1]}`,
  },
];

export function findMaterial(text: string): SpecHit | undefined {
  for (const { canonical, pattern } of MATERIAL_ALIASES) {
    const m = text.match(pattern);
    if (m) return { value: canonical, snippet: m[0].trim() };
  }
  return undefined;
}

export function findFinish(text: string): SpecHit | undefined {
  // "Finish: <x>" wins over a bare keyword appearing inside a description.
  const labelled = text.match(/\bfinish\s*[:=]\s*([^\n|,;]{2,40})/i);
  const scopes = labelled ? [labelled[1], text] : [text];
  for (const scope of scopes) {
    for (const { pattern, normalize } of FINISH_PATTERNS) {
      const m = scope.match(pattern);
      if (m) return { value: normalize ? normalize(m) : m[0].trim(), snippet: m[0].trim() };
    }
  }
  return undefined;
}

export function findTolerance(text: string): SpecHit | undefined {
  const iso = text.match(ISO_TOLERANCE);
  if (iso) return { value: `ISO 2768-${iso[1].toLowerCase()}`, snippet: iso[0].trim() };

  const sym = text.match(SYMBOLIC_TOLERANCE);
  if (sym) {
    // "+/-.005" and "±.005" normalise to the same "±0.005" so envelope
    // comparisons are not defeated by punctuation.
    let v = sym[1];
    if (v.startsWith(".")) v = `0${v}`;
    return { value: `±${v}`, snippet: sym[0].trim() };
  }
  return undefined;
}

export function findRevision(text: string): SpecHit | undefined {
  for (const { pattern, normalize } of REVISION_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { value: normalize(m), snippet: m[0].trim() };
  }
  return undefined;
}

/**
 * Header / title-block specs that apply to every line in the document
 * ("Finish: powder coat black", "REV. C", "Tolerance: ISO 2768-m").
 * Line-level text always wins over these.
 */
export type HeaderSpecs = {
  material?: SpecHit & { line: number };
  finish?: SpecHit & { line: number };
  tolerance?: SpecHit & { line: number };
  revision?: SpecHit & { line: number };
};

export function extractHeaderSpecs(body: string): HeaderSpecs {
  const rows = body.split(/\r?\n/);
  const out: HeaderSpecs = {};

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.trim()) continue;
    // Line-item rows carry their own specs; only non-tabular prose and
    // title-block lines contribute document-wide defaults.
    const isTableRow = row.split("|").length >= 3;
    if (isTableRow) continue;

    if (!out.finish) {
      const hit = findFinish(row);
      if (hit) out.finish = { ...hit, line: i + 1 };
    }
    if (!out.tolerance) {
      const hit = findTolerance(row);
      if (hit) out.tolerance = { ...hit, line: i + 1 };
    }
    if (!out.revision) {
      const hit = findRevision(row);
      if (hit) out.revision = { ...hit, line: i + 1 };
    }
    if (!out.material && /^\s*material\s*[:=]/i.test(row)) {
      const hit = findMaterial(row);
      if (hit) out.material = { ...hit, line: i + 1 };
    }
  }

  return out;
}

export function pointer(args: {
  file: string;
  line?: number;
  snippet: string;
}): SourcePointer {
  return { file: args.file, page: 1, line: args.line, snippet: args.snippet };
}

export function withSource(
  sources: Partial<Record<ExtractedFieldName, SourcePointer>>,
  field: ExtractedFieldName,
  ptr: SourcePointer,
): void {
  sources[field] = ptr;
}
