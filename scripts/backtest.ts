/**
 * K3 backtest harness — PRD §2.
 *
 *   npm run backtest -- --data <path>            # a real shop's export
 *   npm run backtest -- --workspace <id>         # a corpus already loaded
 *
 * Input format, options and caveats: scripts/BACKTEST.md
 *
 * Leave-one-out over the historical corpus. Each held-out priced line is
 * predicted from the remaining corpus through the *exact production path* —
 * resolveAgainstHistory -> priceFromCandidates -> evaluateConfidence — with the
 * clock pinned to the line's own quote date so a prediction can never use data
 * that did not exist when the line was quoted. There is no separate scoring
 * implementation: if the backtest and production diverged, the backtest would
 * be worthless.
 *
 * This refuses to run on the demo corpus. Demo prices are invented and any
 * number measured against them is meaningless.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { openScratchDb } from "./lib/scratchDb";
import { loadInput, type InputLine } from "./lib/backtestInput";

type Args = {
  data?: string;
  costs?: string;
  workspace?: string;
  out: string;
  limit?: number;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { out: "reports/k3-backtest.md" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--data") out.data = next();
    else if (a === "--costs") out.costs = next();
    else if (a === "--workspace") out.workspace = next();
    else if (a === "--out") out.out = next() ?? out.out;
    else if (a === "--limit") out.limit = Number(next());
  }
  return out;
}

function die(message: string): never {
  console.error(`\nbacktest: ${message}\n`);
  process.exit(1);
}

type Prediction = {
  lineId: string;
  actual: number;
  predicted: number | null;
  qty: number;
  quotedAt: Date;
  method: string;
  state: string;
  comparableCount: number;
  blockerCodes: string[];
  partNumber: string | null;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.data && !args.workspace) {
    die(
      "no input. Pass --data <path> with a real shop's export (see scripts/BACKTEST.md),\n" +
        "or --workspace <id> to backtest a corpus already in DATABASE_URL.\n" +
        "K3 cannot be measured without real data.",
    );
  }

  let prisma: PrismaClient;
  let close = async () => {};
  let workspaceId: string;

  if (args.data) {
    const parsed = loadInput(resolvePath(args.data), args.costs ? resolvePath(args.costs) : undefined);
    if (!parsed.lines.length) die(`no priced lines found in ${args.data}`);
    assertNotSeedCorpus(parsed.lines, args.data);

    const db = await openScratchDb("backtest");
    prisma = db.prisma;
    close = db.close;
    workspaceId = await loadWorkspace(prisma, parsed, args.data);
    console.log(`Loaded ${parsed.lines.length} priced lines and ${parsed.costs.length} cost records.`);
  } else {
    const { prisma: p } = await import("../src/lib/db");
    prisma = p;
    close = async () => p.$disconnect();
    workspaceId = args.workspace!;
  }

  try {
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace) die(`workspace ${workspaceId} not found`);
    if (workspace.isDemo) {
      die(
        `workspace "${workspace.name}" is the demo corpus (isDemo = true).\n` +
          "Its prices are synthetic, so any error measured against it is meaningless.\n" +
          "K3 can only be established on a real shop's export. See scripts/BACKTEST.md.",
      );
    }

    const report = await runBacktest(prisma, workspace, args.limit);
    const outPath = resolvePath(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, report, "utf8");
    console.log(`\nWrote ${args.out}`);
  } finally {
    await close();
  }
}

/**
 * A cheap guard against someone exporting prisma/seed.ts and calling the result
 * a measurement. It cannot catch a determined re-labelling, and does not try to.
 */
function assertNotSeedCorpus(lines: InputLine[], path: string): void {
  const seedSignature = ["Q-4412", "Q-4388", "Q-4301", "Q-4502", "Q-4471", "PO-4471", "Q-4200"];
  const present = new Set(lines.map((l) => l.quoteNumber));
  const hits = seedSignature.filter((q) => present.has(q)).length;
  if (hits >= 5 && present.size <= seedSignature.length + 2) {
    die(
      `${path} looks like the corpus from prisma/seed.ts (matched ${hits} of its quote numbers).\n` +
        "Seed data is invented. Any measurement made against it is meaningless.",
    );
  }
}

async function loadWorkspace(
  prisma: PrismaClient,
  parsed: { lines: InputLine[]; costs: Array<{ sku?: string; specHash?: string; unitCost: number; asOfDate: Date; source: string }> },
  label: string,
): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: { name: `Backtest: ${label}`, isDemo: false, capabilityEnvelope: "{}" },
  });

  const accounts = new Map<string, string>();
  for (const l of parsed.lines) {
    if (!l.accountName || accounts.has(l.accountName)) continue;
    const a = await prisma.account.create({
      data: {
        workspaceId: workspace.id,
        name: l.accountName,
        domain: l.accountDomain ?? null,
      },
    });
    accounts.set(l.accountName, a.id);
  }

  // Group lines back into their quotes so quote-number references resolve.
  const quotes = new Map<string, InputLine[]>();
  for (const l of parsed.lines) {
    const key = `${l.quoteNumber}|${l.quotedAt.toISOString()}`;
    (quotes.get(key) ?? quotes.set(key, []).get(key)!).push(l);
  }

  for (const group of quotes.values()) {
    const head = group[0];
    await prisma.historicalQuote.create({
      data: {
        workspaceId: workspace.id,
        accountId: head.accountName ? (accounts.get(head.accountName) ?? null) : null,
        quoteNumber: head.quoteNumber,
        quotedAt: head.quotedAt,
        total: group.reduce((s, l) => s + l.unitPrice * l.qty, 0),
        outcome: head.outcome ?? null,
        competitorPrice: head.competitorPrice ?? null,
        lines: {
          create: group.map((l) => ({
            description: l.description,
            partNumber: l.partNumber ?? null,
            material: l.material ?? null,
            finish: l.finish ?? null,
            tolerance: l.tolerance ?? null,
            revision: l.revision ?? null,
            qty: l.qty,
            unitPrice: l.unitPrice,
            sku: l.sku ?? null,
            specHash: l.specHash ?? null,
            costIndex: l.costIndex ?? null,
          })),
        },
      },
    });
  }

  if (parsed.costs.length) {
    await prisma.costRecord.createMany({
      data: parsed.costs.map((c) => ({
        workspaceId: workspace.id,
        sku: c.sku ?? null,
        specHash: c.specHash ?? null,
        unitCost: c.unitCost,
        asOfDate: c.asOfDate,
        source: c.source,
      })),
    });
  }

  return workspace.id;
}

async function runBacktest(
  prisma: PrismaClient,
  workspace: { id: string; name: string; marginFloorPct: number; requireCostForGreen: boolean; capabilityEnvelope: string },
  limit?: number,
): Promise<string> {
  const { resolveAgainstHistory, priceFromCandidates } = await import("../src/lib/resolve");
  const { evaluateConfidence, violatesEnvelope } = await import("../src/lib/confidence");
  const { resolveCost, marginPct } = await import("../src/lib/cost");

  const all = await prisma.historicalQuoteLine.findMany({
    where: { historicalQuote: { workspaceId: workspace.id } },
    include: { historicalQuote: true },
    orderBy: { historicalQuote: { quotedAt: "desc" } },
  });
  if (!all.length) throw new Error("corpus is empty");

  const costRecordCount = await prisma.costRecord.count({ where: { workspaceId: workspace.id } });
  const envelope = JSON.parse(workspace.capabilityEnvelope || "{}");
  const heldOut = limit && limit > 0 ? all.slice(0, limit) : all;

  const predictions: Prediction[] = [];
  let done = 0;
  for (const line of heldOut) {
    const asOf = line.historicalQuote.quotedAt;
    const fields = {
      description: line.description,
      partNumber: line.partNumber ?? undefined,
      material: line.material ?? undefined,
      finish: line.finish ?? undefined,
      tolerance: line.tolerance ?? undefined,
      revision: line.revision ?? undefined,
    };

    const resolved = await resolveAgainstHistory(
      workspace.id,
      fields,
      line.historicalQuote.accountId,
      { excludeHistoricalLineIds: [line.id], asOf },
    );
    const priced = priceFromCandidates(resolved.candidates, line.qty, {
      now: asOf,
      currentCostIndex: resolved.currentCostIndex,
    });
    const cost = await resolveCost(workspace.id, {
      sku: resolved.sku,
      specHash: resolved.specHash,
    });
    const { state, blockers } = evaluateConfidence({
      fields,
      matchScore: resolved.matchScore,
      matchType: resolved.matchType,
      comparableCount: priced.comparableCount,
      variance: priced.variance,
      unitPrice: priced.unitPrice,
      asOfDate: priced.asOfDate,
      // Corpus lines are already structured: this measures price resolution,
      // not extraction. See the caveat in the report.
      inputQuality: 1,
      envelope: violatesEnvelope(fields, envelope),
      extraBlockers: [...resolved.blockers, ...priced.blockers],
      margin: {
        costKnown: cost != null,
        marginPct: marginPct(priced.unitPrice, cost?.unitCost ?? null),
        floorPct: workspace.marginFloorPct / 100,
        requireCostForGreen: workspace.requireCostForGreen,
      },
      now: asOf,
    });

    predictions.push({
      lineId: line.id,
      actual: line.unitPrice,
      predicted: state === "RED" ? null : priced.unitPrice,
      qty: line.qty,
      quotedAt: asOf,
      method: priced.method,
      state,
      comparableCount: priced.comparableCount,
      blockerCodes: blockers.map((b) => b.code),
      partNumber: line.partNumber,
    });

    if (++done % 100 === 0) console.log(`  ${done}/${heldOut.length} lines`);
  }

  return renderReport({
    workspace,
    corpus: all,
    heldOut: heldOut.length,
    sampled: heldOut.length !== all.length,
    costRecordCount,
    predictions,
  });
}

// ---------------------------------------------------------------- statistics

function relErr(p: Prediction): number | null {
  if (p.predicted == null || !(p.actual > 0)) return null;
  return Math.abs(p.predicted - p.actual) / p.actual;
}

function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function pct(n: number | null): string {
  return n == null ? "—" : `${(n * 100).toFixed(1)}%`;
}

function distribution(errors: number[]) {
  const sorted = [...errors].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p10: percentile(sorted, 0.1),
    p50: percentile(sorted, 0.5),
    p70: percentile(sorted, 0.7),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    within10: sorted.length ? sorted.filter((e) => e <= 0.1).length / sorted.length : null,
  };
}

function qtyBucket(qty: number): string {
  if (qty < 10) return "1–9";
  if (qty < 100) return "10–99";
  if (qty < 1000) return "100–999";
  return "1000+";
}

function groupRows(
  predictions: Prediction[],
  key: (p: Prediction) => string,
  order?: string[],
): string[] {
  const groups = new Map<string, Prediction[]>();
  for (const p of predictions) {
    const k = key(p);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
  }
  const keys = order
    ? order.filter((k) => groups.has(k)).concat([...groups.keys()].filter((k) => !order.includes(k)))
    : [...groups.keys()].sort();

  return keys.map((k) => {
    const g = groups.get(k)!;
    const errs = g.map(relErr).filter((e): e is number => e != null);
    const d = distribution(errs);
    return `| ${k} | ${g.length} | ${d.n} | ${pct(d.p50)} | ${pct(d.p90)} | ${pct(d.within10)} |`;
  });
}

function renderReport(args: {
  workspace: { name: string; marginFloorPct: number; requireCostForGreen: boolean };
  corpus: Array<{ qty: number; partNumber: string | null; description: string; historicalQuote: { quotedAt: Date } }>;
  heldOut: number;
  sampled: boolean;
  costRecordCount: number;
  predictions: Prediction[];
}): string {
  const { predictions } = args;
  const dates = args.corpus.map((l) => l.historicalQuote.quotedAt.getTime());
  const items = new Set(args.corpus.map((l) => l.partNumber ?? l.description));

  const predicted = predictions.filter((p) => p.predicted != null);
  const unpredicted = predictions.filter((p) => p.predicted == null);
  const errors = predicted.map(relErr).filter((e): e is number => e != null);
  const overall = distribution(errors);

  const green = predictions.filter((p) => p.state === "GREEN");
  const amber = predictions.filter((p) => p.state === "AMBER");
  const greenDist = distribution(green.map(relErr).filter((e): e is number => e != null));
  const amberDist = distribution(amber.map(relErr).filter((e): e is number => e != null));

  const k3Pass = overall.within10 != null && overall.within10 >= 0.7;
  const verdict =
    overall.n === 0
      ? "**NOT MEASURABLE** — no line could be priced."
      : k3Pass
        ? `**PASS** — ${pct(overall.within10)} of predicted lines are within ±10% (K3 threshold: ≥70%).`
        : `**FAIL** — ${pct(overall.within10)} of predicted lines are within ±10% (K3 threshold: ≥70%).`;

  const blockerCounts = new Map<string, number>();
  for (const p of unpredicted) {
    for (const c of p.blockerCodes) blockerCounts.set(c, (blockerCounts.get(c) ?? 0) + 1);
  }

  const state = (s: string) => predictions.filter((p) => p.state === s).length;
  const share = (n: number) =>
    predictions.length ? `${((n / predictions.length) * 100).toFixed(1)}%` : "—";

  return `# K3 backtest — ${args.workspace.name}

Generated by \`npm run backtest\`. Method, input format and caveats:
[scripts/BACKTEST.md](../scripts/BACKTEST.md).

Leave-one-out over the historical corpus, each held-out line predicted from the
remaining corpus through the exact production path, with the clock pinned to
that line's own quote date so no prediction uses data from its future.

## Corpus

| | |
|---|---|
| Priced historical lines | ${args.corpus.length.toLocaleString()} |
| Distinct items | ${items.size.toLocaleString()} |
| Date range | ${new Date(Math.min(...dates)).toISOString().slice(0, 10)} → ${new Date(Math.max(...dates)).toISOString().slice(0, 10)} |
| Cost records | ${args.costRecordCount.toLocaleString()} |
| Margin floor | ${args.workspace.marginFloorPct}% |
| Cost required for GREEN | ${args.workspace.requireCostForGreen ? "yes" : "no"} |
| Lines held out and scored | ${args.heldOut.toLocaleString()}${args.sampled ? " (**sampled** — see --limit)" : ""} |

PRD §7 puts the minimum viable corpus at ~300 priced lines and ≥50 distinct
items. ${args.corpus.length < 300 || items.size < 50 ? "**This corpus is below that minimum, so these numbers describe a starved system, not the product's ceiling.**" : "This corpus meets that minimum."}

## K3 verdict

${verdict}

## Relative error distribution

\`|predicted − actual| / actual\`, over the ${predicted.length.toLocaleString()} lines that produced a price.
Percentiles, not the mean — the mean hides the tail that bankrupts a shop.

| p10 | p50 | p70 | p90 | p99 |
|---:|---:|---:|---:|---:|
| ${pct(overall.p10)} | ${pct(overall.p50)} | ${pct(overall.p70)} | ${pct(overall.p90)} | ${pct(overall.p99)} |

**Within ±10%: ${pct(overall.within10)}** of ${overall.n.toLocaleString()} priced lines.

## Confidence-state distribution

| State | Lines | Share |
|---|---:|---:|
| GREEN | ${state("GREEN")} | ${share(state("GREEN"))} |
| AMBER | ${state("AMBER")} | ${share(state("AMBER"))} |
| RED | ${state("RED")} | ${share(state("RED"))} |

### Error within GREEN specifically

A wrong GREEN line is a far more serious failure than a high RED rate: RED asks
the buyer a question, GREEN sends a price with no human in the loop.

| State | Lines priced | p50 | p90 | Within ±10% |
|---|---:|---:|---:|---:|
| GREEN | ${greenDist.n} | ${pct(greenDist.p50)} | ${pct(greenDist.p90)} | ${pct(greenDist.within10)} |
| AMBER | ${amberDist.n} | ${pct(amberDist.p50)} | ${pct(amberDist.p90)} | ${pct(amberDist.within10)} |

${
  greenDist.p50 != null && amberDist.p50 != null && greenDist.p50 > amberDist.p50
    ? "> **GREEN error is worse than AMBER error.** The gate is selecting for the wrong thing: it is auto-sending the prices it is least accurate on. This is a more serious finding than the headline K3 number and must be resolved before any pilot."
    : greenDist.n === 0
      ? "> No line reached GREEN, so GREEN accuracy is unmeasured. Check the blocker table below for why."
      : "> GREEN error is at or below AMBER error, which is the ordering the gate is supposed to produce."
}

## Error by quantity bucket

Whether quantity-aware pricing actually worked.

| Quantity | Lines | Priced | p50 | p90 | Within ±10% |
|---|---:|---:|---:|---:|---:|
${groupRows(predictions, (p) => qtyBucket(p.qty), ["1–9", "10–99", "100–999", "1000+"]).join("\n")}

## Error by pricing method

| Method | Lines | Priced | p50 | p90 | Within ±10% |
|---|---:|---:|---:|---:|---:|
${groupRows(predictions, (p) => p.method, ["loglog_fit", "nearest_qty", "single_comparable", "none"]).join("\n")}

## Lines that could not be predicted

${unpredicted.length.toLocaleString()} of ${predictions.length.toLocaleString()} lines produced no price${
    unpredicted.length ? ". Grouped by blocker code (a line can carry several):" : "."
  }

${
  unpredicted.length
    ? `| Blocker | Lines |\n|---|---:|\n${[...blockerCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `| \`${c}\` | ${n} |`)
        .join("\n")}`
    : ""
}

## What this number does not say

1. **It measures price resolution, not extraction.** Corpus lines are already
   structured, so \`extractConf\` is pinned at 1.0. A real inbound RFQ arrives as
   a scanned print or an email thread and must be parsed first. This is an upper
   bound on end-to-end accuracy.
2. **The target is what the shop quoted, not what the job was worth.** K3 asks
   whether the draft matches what the estimator would have quoted, which is what
   this measures — but a historical price can itself be wrong.
3. No threshold in \`CONFIDENCE_THRESHOLDS\` or \`PRICING_CONFIG\` was tuned
   against this report.
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
