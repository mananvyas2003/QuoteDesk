/**
 * Fifteen hand-written inbound RFQs covering the input shapes §5.1 of the PRD
 * names. These exist to exercise the pipeline's *structure* — which confidence
 * state each shape can reach — not to measure pricing accuracy. Pricing
 * accuracy is only measurable against a real shop's corpus (scripts/backtest.ts).
 */
export type BenchRfq = {
  id: string;
  shape: string;
  subject: string;
  fromEmail: string;
  body: string;
};

export const BENCH_RFQS: BenchRfq[] = [
  {
    id: "R01",
    shape: "pipe table, fully specified",
    subject: "RFQ 8812 — base plates",
    fromEmail: "buyer@acmeindustrial.example",
    body: `Hi — please quote the following. Finish: powder coat black. Tolerance: ±1/16. Drawing Rev C.

Part | Description | Qty | Material
BP-1218 | Base plate 12x18x0.5 | 50 | A36
`,
  },
  {
    id: "R02",
    shape: "pipe table, finish not stated",
    subject: "Quote request — guard brackets",
    fromEmail: "buyer@acmeindustrial.example",
    body: `Need pricing on the below. Tolerance ±0.030, Rev B.

Part | Description | Qty | Material
GB-88 | Guard bracket laser cut | 100 | A36
`,
  },
  {
    id: "R03",
    shape: "qty-first shorthand",
    subject: "Bracket pricing",
    fromEmail: "buyer@acmeindustrial.example",
    body: `100x Guard bracket laser cut PN-GB-88 A36
Finish: powder coat black, ISO 2768-m, REV. B`,
  },
  {
    id: "R04",
    shape: "prose request",
    subject: "Pricing needed",
    fromEmail: "purchasing@northstareq.example",
    body: `Morning — we need 40 SS shaft collar 2in for a rebuild.
Material SS304, passivate finish, ISO 2768-m, Rev A. Quote by 12/12/2026.`,
  },
  {
    id: "R05",
    shape: "same-as prior PO",
    subject: "Repeat order",
    fromEmail: "purchasing@northstareq.example",
    body: `Same as PO 4471 but 400 units this time. Same print, Rev D, primer finish, ISO 2768-m.`,
  },
  {
    id: "R06",
    shape: "scanned drawing, no specs",
    subject: "Print attached",
    fromEmail: "eng@northstareq.example",
    body: `See attached scan. Hard to read — please quote off the print.
[scan-0413.pdf — 1 page, skewed raster, title block illegible]`,
  },
  {
    id: "R07",
    shape: "quantity breaks",
    subject: "Angle clips — price breaks",
    fromEmail: "buyer@acmeindustrial.example",
    body: `Please price AC-33 angle clip 3x3x0.25 at 100/500/1000.
Material A36, mill finish, ±1/16, Rev A.`,
  },
  {
    id: "R08",
    shape: "table plus contradicting same-as note",
    subject: "Frames — repeat",
    fromEmail: "purchasing@northstareq.example",
    body: `Same as PO 4471 but 400 units.

Part | Description | Qty | Material
WF-2436 | Weldment frame 24x36 | 25 | A572
`,
  },
  {
    id: "R09",
    shape: "new account, no account history",
    subject: "New supplier enquiry",
    fromEmail: "rfq@harborworks.example",
    body: `We are a new customer. Please quote 60 Base plate 12x18x0.5, PN BP-1218, A36,
powder coat black, ±1/16, Rev C.`,
  },
  {
    id: "R10",
    shape: "quantity far outside history",
    subject: "Volume enquiry",
    fromEmail: "buyer@acmeindustrial.example",
    body: `Large programme coming. Quote 50000 Angle clip 3x3x0.25 PN AC-33 A36,
mill finish, ±1/16, Rev A.`,
  },
  {
    id: "R11",
    shape: "capability envelope violation",
    subject: "Titanium housings",
    fromEmail: "eng@northstareq.example",
    body: `Quote 20 Housing shell Ti-6Al-4V titanium, anodize, ±0.0005, Rev A.`,
  },
  {
    id: "R12",
    shape: "title-block header applying to table",
    subject: "RFQ — packet 22-118",
    fromEmail: "buyer@acmeindustrial.example",
    body: `TITLE BLOCK
Drawing: 22-118    REV. C
Finish: powder coat black
Tolerance: ISO 2768-m
Material: A36

Part | Description | Qty | Material
GB-88 | Guard bracket laser cut | 200 | A36
`,
  },
  {
    id: "R13",
    shape: "tight tolerance class",
    subject: "Collar rework",
    fromEmail: "purchasing@northstareq.example",
    body: `Quote 80 SS shaft collar 2in PN SC-200 SS304.
Passivate. ISO 2768-f. Rev-R3.`,
  },
  {
    id: "R14",
    shape: "unknown part, no history",
    subject: "One-off",
    fromEmail: "buyer@acmeindustrial.example",
    body: `Please price 10 Hydraulic manifold block XZ-9931, aluminum, anodize, +/-.005, Rev A.`,
  },
  {
    id: "R15",
    shape: "multi-line mixed table",
    subject: "RFQ 8830 — mixed packet",
    fromEmail: "buyer@acmeindustrial.example",
    body: `Finish: mill. Tolerance ±1/16. Rev A throughout.

Part | Description | Qty | Material
BP-1218 | Base plate 12x18x0.5 | 40 | A36
AC-33 | Angle clip 3x3x0.25 | 500 | A36
GB-88 | Guard bracket laser cut | 150 | A36
`,
  },
];
