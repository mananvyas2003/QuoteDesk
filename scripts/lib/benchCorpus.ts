import type { PrismaClient } from "@prisma/client";

/**
 * A purpose-built measurement instrument for scripts/confidence-distribution.ts.
 *
 * READ THIS BEFORE USING THE NUMBERS IT PRODUCES.
 *
 * This corpus is *designed so that GREEN is achievable*: the items the bench
 * RFQs ask for have three or more recent comparables at several quantities,
 * low price dispersion, materials inside the capability envelope, and resolved
 * cost records above the margin floor. That is the whole point — if GREEN is
 * still unreachable against a corpus built to reach it, the gate is broken by
 * construction rather than starved of data.
 *
 * It measures *structure* (which confidence states the pipeline can produce),
 * never *accuracy*. The prices below are invented. Any statement about pricing
 * error must come from scripts/backtest.ts run on a real shop's export.
 */

export type CorpusLine = {
  description: string;
  partNumber: string;
  material: string;
  finish?: string;
  qty: number;
  unitPrice: number;
  sku: string;
};

const monthsAgo = (n: number) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
};

export const BENCH_ENVELOPE = {
  materials: ["A36", "A572", "SS304", "SS316", "AL6061", "Mild Steel", "Aluminum"],
  maxSizeIn: 120,
  toleranceClasses: ["±1/16", "±0.030", "ISO 2768-m", "ISO 2768-f"],
  certifications: ["ISO 9001"],
  maxLeadDays: 45,
  minOrderValue: 250,
};

type QuoteSpec = {
  account: "acme" | "northstar";
  quoteNumber: string;
  monthsAgo: number;
  outcome?: "won" | "lost" | "no_decision";
  competitorPrice?: number;
  lines: CorpusLine[];
};

function bp(qty: number, unitPrice: number): CorpusLine {
  return {
    description: "Base plate 12x18x0.5",
    partNumber: "BP-1218",
    material: "A36",
    finish: "powder coat black",
    qty,
    unitPrice,
    sku: "FAB-BP-1218",
  };
}

function gb(qty: number, unitPrice: number): CorpusLine {
  return {
    description: "Guard bracket laser cut",
    partNumber: "GB-88",
    material: "A36",
    finish: "powder coat black",
    qty,
    unitPrice,
    sku: "FAB-GB-88",
  };
}

function ac(qty: number, unitPrice: number): CorpusLine {
  return {
    description: "Angle clip 3x3x0.25",
    partNumber: "AC-33",
    material: "A36",
    finish: "mill",
    qty,
    unitPrice,
    sku: "FAB-AC-33",
  };
}

function sc(qty: number, unitPrice: number): CorpusLine {
  return {
    description: "SS shaft collar 2in",
    partNumber: "SC-200",
    material: "SS304",
    finish: "passivate",
    qty,
    unitPrice,
    sku: "FAB-SC-200",
  };
}

function wf(qty: number, unitPrice: number): CorpusLine {
  return {
    description: "Weldment frame 24x36",
    partNumber: "WF-2436",
    material: "A572",
    finish: "primer",
    qty,
    unitPrice,
    sku: "FAB-WF-2436",
  };
}

const QUOTES: QuoteSpec[] = [
  { account: "acme", quoteNumber: "Q-4412", monthsAgo: 1, outcome: "won", lines: [bp(50, 48.5), gb(100, 12.75)] },
  { account: "acme", quoteNumber: "Q-4402", monthsAgo: 2, outcome: "won", lines: [bp(25, 52.0), gb(200, 11.4)] },
  { account: "acme", quoteNumber: "Q-4388", monthsAgo: 3, outcome: "no_decision", lines: [bp(40, 49.25), ac(500, 3.2)] },
  { account: "acme", quoteNumber: "Q-4371", monthsAgo: 4, outcome: "won", lines: [bp(60, 47.8), gb(150, 12.1)] },
  { account: "acme", quoteNumber: "Q-4350", monthsAgo: 5, outcome: "lost", competitorPrice: 45.0, lines: [bp(100, 46.9)] },
  { account: "acme", quoteNumber: "Q-4330", monthsAgo: 6, outcome: "won", lines: [ac(100, 4.05), gb(250, 11.2)] },
  { account: "acme", quoteNumber: "Q-4311", monthsAgo: 7, outcome: "won", lines: [ac(1000, 2.85)] },
  { account: "acme", quoteNumber: "Q-4290", monthsAgo: 8, outcome: "no_decision", lines: [ac(250, 3.45), gb(120, 12.4)] },
  { account: "acme", quoteNumber: "Q-4265", monthsAgo: 9, lines: [bp(30, 50.4), ac(400, 3.3)] },
  { account: "northstar", quoteNumber: "Q-4502", monthsAgo: 1, outcome: "won", lines: [sc(80, 22.4), wf(10, 385)] },
  { account: "northstar", quoteNumber: "Q-4480", monthsAgo: 2, outcome: "won", lines: [sc(40, 23.1), wf(8, 400)] },
  { account: "northstar", quoteNumber: "PO-4471", monthsAgo: 3, outcome: "won", lines: [wf(12, 390), sc(120, 21.8)] },
  { account: "northstar", quoteNumber: "Q-4455", monthsAgo: 5, outcome: "no_decision", lines: [sc(160, 21.2), wf(20, 372)] },
  { account: "northstar", quoteNumber: "Q-4430", monthsAgo: 7, outcome: "won", lines: [sc(60, 22.8), wf(6, 408)] },
  { account: "northstar", quoteNumber: "Q-4410", monthsAgo: 9, lines: [sc(200, 20.9), wf(30, 365)] },
];

/** Unit cost per SKU — comfortably under the 25% margin floor at quoted prices. */
const COSTS: Array<{ sku: string; unitCost: number }> = [
  { sku: "FAB-BP-1218", unitCost: 28.0 },
  { sku: "FAB-GB-88", unitCost: 7.1 },
  { sku: "FAB-AC-33", unitCost: 1.65 },
  { sku: "FAB-SC-200", unitCost: 12.9 },
  { sku: "FAB-WF-2436", unitCost: 235.0 },
];

export async function buildBenchWorkspace(prisma: PrismaClient) {
  const workspace = await prisma.workspace.create({
    data: {
      name: "Bench Fab (instrument corpus)",
      vertical: "metal_fabrication",
      marginFloorPct: 25,
      capabilityEnvelope: JSON.stringify(BENCH_ENVELOPE),
      onboardedAt: new Date(),
    },
  });

  await prisma.user.create({
    data: {
      workspaceId: workspace.id,
      email: "estimator@bench.example",
      name: "Bench Estimator",
      role: "estimator",
    },
  });

  const acme = await prisma.account.create({
    data: { workspaceId: workspace.id, name: "Acme Industrial", domain: "acmeindustrial.example" },
  });
  const northstar = await prisma.account.create({
    data: { workspaceId: workspace.id, name: "Northstar Equipment", domain: "northstareq.example" },
  });
  const accountId = { acme: acme.id, northstar: northstar.id };

  for (const q of QUOTES) {
    // Outcome + competitorPrice on historical quotes only exist after Task 4's
    // migration; stay compatible with the pre-fix schema so the same instrument
    // can produce the baseline and the post-fix numbers.
    const outcomeFields = outcomeColumnsExist(prisma)
      ? { outcome: q.outcome ?? null, competitorPrice: q.competitorPrice ?? null }
      : {};
    await prisma.historicalQuote.create({
      data: {
        workspaceId: workspace.id,
        accountId: accountId[q.account],
        quoteNumber: q.quoteNumber,
        quotedAt: monthsAgo(q.monthsAgo),
        total: q.lines.reduce((s, l) => s + l.unitPrice * l.qty, 0),
        ...outcomeFields,
        lines: {
          create: q.lines.map((l) => ({
            description: l.description,
            partNumber: l.partNumber,
            material: l.material,
            finish: l.finish,
            qty: l.qty,
            unitPrice: l.unitPrice,
            sku: l.sku,
            specHash: `${l.partNumber}|${l.material}|${l.finish ?? ""}`.toLowerCase(),
          })),
        },
      } as never,
    });
  }

  const costRecord = (prisma as unknown as Record<string, unknown>).costRecord;
  if (costRecord) {
    await (costRecord as { createMany: (a: unknown) => Promise<unknown> }).createMany({
      data: COSTS.map((c) => ({
        workspaceId: workspace.id,
        sku: c.sku,
        specHash: null,
        unitCost: c.unitCost,
        asOfDate: monthsAgo(1),
        source: "vendor_list",
      })),
    });
  }

  return { workspace, accounts: { acme, northstar } };
}

function outcomeColumnsExist(prisma: PrismaClient): boolean {
  const fields = (
    prisma as unknown as {
      _runtimeDataModel?: { models?: Record<string, { fields: Array<{ name: string }> }> };
    }
  )._runtimeDataModel?.models?.HistoricalQuote?.fields;
  return Boolean(fields?.some((f) => f.name === "outcome"));
}
