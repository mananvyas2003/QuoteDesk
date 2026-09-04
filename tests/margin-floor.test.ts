import { before, test } from "node:test";
import assert from "node:assert/strict";
import { testDb, monthsAgo } from "./helpers/db";

/**
 * Task 6 guards — PRD §5.4's override rule, "any line whose derived price falls
 * below a customer-configured margin floor is forced to AMBER regardless of
 * match confidence". This is the check that decides whether a pilot is
 * approved, and it was a no-op: `const belowMarginFloor = false;`.
 *
 * These run the full ingest -> resolve -> price -> gate -> persist path.
 */

const ENVELOPE = JSON.stringify({
  materials: ["A36", "A572", "SS304"],
  toleranceClasses: ["±1/16", "ISO 2768-m"],
});

/** Four comparables on a normal downward curve around $100/unit. */
function curve(partNumber: string, description: string) {
  return [
    { qty: 25, unitPrice: 112 },
    { qty: 50, unitPrice: 104 },
    { qty: 100, unitPrice: 98 },
    { qty: 200, unitPrice: 92 },
  ].map((r) => ({
    description,
    partNumber,
    material: "A36",
    finish: "powder coat black",
    sku: `SKU-${partNumber}`,
    qty: r.qty,
    unitPrice: r.unitPrice,
  }));
}

function rfqBody(partNumber: string, description: string, qty: number) {
  return `Finish: powder coat black
Tolerance: ±1/16
Rev C

Part | Description | Qty | Material
${partNumber} | ${description} | ${qty} | A36
`;
}

type Ctx = { requireCost: string; allowUnknown: string };
let ctx: Ctx;

async function buildWorkspace(name: string, requireCostForGreen: boolean): Promise<string> {
  const prisma = await testDb();
  const ws = await prisma.workspace.create({
    data: {
      name,
      marginFloorPct: 25,
      requireCostForGreen,
      capabilityEnvelope: ENVELOPE,
      onboardedAt: new Date(),
    },
  });
  await prisma.account.create({
    data: { workspaceId: ws.id, name: "Margin Co", domain: "marginco.example" },
  });

  for (const [pn, desc] of [
    ["FAT-1", "Fat margin bracket"],
    ["THIN-1", "Thin margin bracket"],
    ["NOCOST-1", "Uncosted bracket"],
  ]) {
    for (const [i, line] of curve(pn, desc).entries()) {
      await prisma.historicalQuote.create({
        data: {
          workspaceId: ws.id,
          accountId: (await prisma.account.findFirstOrThrow({ where: { workspaceId: ws.id } })).id,
          quoteNumber: `${pn}-Q${i}`,
          quotedAt: monthsAgo(i + 1),
          lines: { create: [line] },
        },
      });
    }
  }

  // Cost records resolve for two of the three items.
  await prisma.costRecord.createMany({
    data: [
      // $98 price at qty 100 vs $45 cost -> ~54% margin, comfortably above 25%.
      { workspaceId: ws.id, sku: "SKU-FAT-1", unitCost: 45, asOfDate: monthsAgo(1), source: "vendor_list" },
      // $98 price at qty 100 vs $80 cost -> ~18% margin, below the 25% floor.
      { workspaceId: ws.id, sku: "SKU-THIN-1", unitCost: 80, asOfDate: monthsAgo(1), source: "vendor_list" },
    ],
  });

  return ws.id;
}

async function draft(workspaceId: string, pn: string, desc: string, qty = 100) {
  const { ingestRfq } = await import("../src/lib/ingest");
  const { quote } = await ingestRfq({
    workspaceId,
    subject: `RFQ ${pn}`,
    fromEmail: "buyer@marginco.example",
    body: rfqBody(pn, desc, qty),
    fileName: "rfq.txt",
  });
  assert.equal(quote.lines.length, 1, "expected exactly one drafted line");
  return quote.lines[0];
}

before(async () => {
  ctx = {
    requireCost: await buildWorkspace("Margin Floor Shop", true),
    allowUnknown: await buildWorkspace("Unknown Margin Allowed Shop", false),
  };
});

test("(a) a line above the margin floor with a resolved cost is GREEN", async () => {
  const line = await draft(ctx.requireCost, "FAT-1", "Fat margin bracket");

  assert.equal(line.confidenceState, "GREEN");
  assert.ok(line.marginPct != null, "margin must be computed and persisted when cost resolves");
  assert.ok(line.marginPct! > 0.25, `expected margin above the 25% floor, got ${line.marginPct}`);
});

test("(b) the same line with cost under the floor is AMBER, with the margin stated", async () => {
  const line = await draft(ctx.requireCost, "THIN-1", "Thin margin bracket");

  assert.equal(line.confidenceState, "AMBER", "PRD §5.4 override: below the floor forces AMBER");
  assert.ok(line.marginPct != null);
  assert.ok(line.marginPct! <= 0.25, `expected margin at or below the floor, got ${line.marginPct}`);
  assert.ok(line.assumption, "an AMBER line must publish an assumption");
  assert.match(
    line.assumption!.text,
    /margin/i,
    "the margin must be stated in the assumption the buyer sees",
  );
  assert.match(line.assumption!.text, /\d+(\.\d+)?%/, "the assumption must state the number");
});

test("(c) no cost record with requireCostForGreen is AMBER, never GREEN", async () => {
  const line = await draft(ctx.requireCost, "NOCOST-1", "Uncosted bracket");

  assert.notEqual(line.confidenceState, "GREEN", "unknown margin must not silently pass");
  assert.equal(line.confidenceState, "AMBER");
  assert.equal(line.marginPct, null);
  assert.match(line.assumption!.text, /cost record/i);
});

test("requireCostForGreen is on by default and can be turned off explicitly", async () => {
  const prisma = await testDb();
  const fresh = await prisma.workspace.create({ data: { name: "Default Shop" } });
  assert.equal(fresh.requireCostForGreen, true, "unknown margin must not silently pass by default");

  // With the requirement lifted, the same uncosted line can reach GREEN.
  const line = await draft(ctx.allowUnknown, "NOCOST-1", "Uncosted bracket");
  assert.equal(line.confidenceState, "GREEN");
});
