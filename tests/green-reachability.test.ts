import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRfqInput } from "../src/lib/extract";
import {
  buildAssumption,
  buildClarification,
  evaluateConfidence,
  violatesEnvelope,
} from "../src/lib/confidence";
import type { CapabilityEnvelope } from "../src/lib/types";

/**
 * PERMANENT REGRESSION GUARD (Task 1).
 *
 * GREEN must be reachable. A fully-specified line — part number, material,
 * finish, tolerance, revision — with three or more recent low-variance
 * comparables and a quantity inside the supported range must return GREEN.
 *
 * Before the Task 1 fix this failed because no extractor ever assigned a
 * `finish`, and `missingSpec()` made a missing finish disqualifying for GREEN,
 * so every ingested line was AMBER or RED by construction.
 */

const ENVELOPE: CapabilityEnvelope = {
  materials: ["A36", "A572", "SS304", "SS316", "AL6061"],
  toleranceClasses: ["±1/16", "±0.030", "ISO 2768-m", "ISO 2768-f"],
  maxLeadDays: 45,
  minOrderValue: 250,
};

const FULLY_SPECIFIED_RFQ = `Please quote the following.
Finish: powder coat black
Tolerance: ±1/16
Drawing Rev C

Part | Description | Qty | Material
GB-88 | Guard bracket laser cut | 100 | A36
`;

function monthsAgo(n: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}

test("a fully specified RFQ line yields material, finish, tolerance and revision", () => {
  const parsed = parseRfqInput({ body: FULLY_SPECIFIED_RFQ, fileName: "rfq.txt" });
  assert.equal(parsed.lines.length, 1, "expected exactly one extracted line");
  const f = parsed.lines[0].extractedFields;

  assert.equal(f.partNumber, "GB-88");
  assert.equal(f.material, "A36");
  assert.equal(f.finish, "powder coat black");
  assert.equal(f.tolerance, "±1/16");
  assert.equal(f.revision, "Rev C");
});

test("GREEN is reachable: fully specified line + strong comparables", () => {
  const parsed = parseRfqInput({ body: FULLY_SPECIFIED_RFQ, fileName: "rfq.txt" });
  const line = parsed.lines[0];
  const fields = line.extractedFields;

  const envelope = violatesEnvelope(fields, ENVELOPE);
  assert.equal(envelope.violated, false, "fully specified line must not violate the envelope");

  const { state } = evaluateConfidence({
    fields,
    matchScore: 0.98,
    matchType: "exact",
    comparableCount: 4,
    variance: 0.05,
    unitPrice: 12.35,
    asOfDate: monthsAgo(1),
    inputQuality: line.extractConf,
    envelope,
    // Quantity 100 sits inside the comparable range; no pricing blockers.
    extraBlockers: [],
    margin: {
      costKnown: true,
      marginPct: 0.42,
      floorPct: 0.25,
      requireCostForGreen: true,
    },
  });

  assert.equal(state, "GREEN");
});

test("every extracted spec field carries a source pointer", () => {
  const parsed = parseRfqInput({ body: FULLY_SPECIFIED_RFQ, fileName: "rfq.txt" });
  const sources = parsed.lines[0].extractedFields.sources ?? {};

  for (const field of ["partNumber", "material", "finish", "tolerance", "revision"] as const) {
    const ptr = sources[field];
    assert.ok(ptr, `${field} must carry a source pointer`);
    assert.equal(ptr.file, "rfq.txt");
    assert.ok(ptr.line && ptr.line > 0, `${field} pointer must cite a line`);
    assert.ok(ptr.snippet && ptr.snippet.length > 0, `${field} pointer must quote the source`);
  }
  // Header-declared specs cite the header line, not the table row.
  assert.notEqual(sources.finish!.line, sources.partNumber!.line);
});

test("a missing finish is AMBER, not RED — assumable, and stated in the assumption", () => {
  const parsed = parseRfqInput({
    body: `Tolerance: ±1/16
Rev C

Part | Description | Qty | Material
GB-88 | Guard bracket laser cut | 100 | A36
`,
    fileName: "rfq.txt",
  });
  const fields = parsed.lines[0].extractedFields;
  assert.equal(fields.finish, undefined);

  const { state, blockers } = evaluateConfidence({
    fields,
    matchScore: 0.98,
    matchType: "exact",
    comparableCount: 4,
    variance: 0.05,
    unitPrice: 12.35,
    asOfDate: monthsAgo(1),
    inputQuality: 0.85,
    envelope: { violated: false },
    margin: { costKnown: true, marginPct: 0.42, floorPct: 0.25, requireCostForGreen: true },
  });

  assert.equal(state, "AMBER");
  const finish = blockers.find((b) => b.code === "missing_finish");
  assert.ok(finish, "missing finish must raise a blocker");
  assert.equal(finish.kind, "assumable");
  assert.match(buildAssumption({ blockers }), /finish is assumed mill \/ as-fabricated/);
});

test("an unassumable blocker forces RED and a clarification, never a price", () => {
  const { state, blockers } = evaluateConfidence({
    fields: { description: "Illegible scan" },
    matchScore: 0,
    matchType: "none",
    comparableCount: 0,
    variance: null,
    unitPrice: null,
    asOfDate: null,
    inputQuality: 0.4,
    envelope: { violated: false },
  });

  assert.equal(state, "RED");
  assert.ok(blockers.some((b) => b.code === "no_resolvable_item" && b.kind === "unassumable"));
  assert.ok(blockers.some((b) => b.code === "no_price_basis" && b.kind === "unassumable"));
  assert.match(
    buildClarification({ blockers, fields: { description: "Illegible scan" }, lineLabel: "Line 1" }),
    /please confirm/i,
  );
});

test("title-block header specs apply to table rows that do not restate them", () => {
  const parsed = parseRfqInput({
    body: `TITLE BLOCK
Drawing: 22-118    REV. C
Finish: powder coat black
Tolerance: ISO 2768-m

Part | Description | Qty | Material
GB-88 | Guard bracket laser cut | 200 | A36
`,
    fileName: "packet.txt",
  });
  const f = parsed.lines[0].extractedFields;
  assert.equal(f.finish, "powder coat black");
  assert.equal(f.tolerance, "ISO 2768-m");
  assert.equal(f.revision, "Rev C");
  assert.equal(f.material, "A36");
});

test("the material cell is not confused with the description cell", () => {
  // "Base plate 12x18x0.5" contains the word "plate"; the old keyword matcher
  // assigned it as the material, dropping A36 and tripping the envelope check.
  const parsed = parseRfqInput({
    body: `Part | Description | Qty | Material
BP-1218 | Base plate 12x18x0.5 | 50 | A36
`,
    fileName: "rfq.txt",
  });
  const f = parsed.lines[0].extractedFields;
  assert.equal(f.material, "A36");
  assert.equal(f.description, "Base plate 12x18x0.5");
  assert.equal(f.partNumber, "BP-1218");
  assert.equal(violatesEnvelope(f, ENVELOPE).violated, false);
});
