/**
 * Task 0 instrument — what confidence states can this pipeline actually produce?
 *
 * Ingests 15 hand-written RFQs (scripts/lib/benchRfqs.ts) against a corpus
 * deliberately built so GREEN is reachable (scripts/lib/benchCorpus.ts), then
 * prints the count and percentage of resulting quote lines in each state.
 *
 * This measures structure, not accuracy. It answers "can a line reach GREEN at
 * all?", never "is the price right?". Pricing error is only measurable against
 * a real corpus — see scripts/backtest.ts.
 *
 *   npx tsx scripts/confidence-distribution.ts [--markdown]
 */
import { openScratchDb } from "./lib/scratchDb";
import { buildBenchWorkspace } from "./lib/benchCorpus";
import { BENCH_RFQS } from "./lib/benchRfqs";

type Row = {
  rfq: string;
  shape: string;
  states: string[];
  detail: string[];
};

async function main() {
  const markdown = process.argv.includes("--markdown");
  // --no-costs loads the same corpus without cost records, to show what
  // workspace.requireCostForGreen (Task 6) costs in GREEN coverage.
  const withCostRecords = !process.argv.includes("--no-costs");
  const db = await openScratchDb("confdist");

  try {
    const { workspace } = await buildBenchWorkspace(db.prisma, { withCostRecords });
    const { ingestRfq } = await import("../src/lib/ingest");

    const rows: Row[] = [];
    const tally: Record<string, number> = { GREEN: 0, AMBER: 0, RED: 0 };

    for (const r of BENCH_RFQS) {
      const detail: string[] = [];
      let states: string[] = [];
      try {
        const { quote } = await ingestRfq({
          workspaceId: workspace.id,
          subject: r.subject,
          fromEmail: r.fromEmail,
          body: r.body,
          channel: "upload",
          fileName: `${r.id}.txt`,
        });
        states = quote.lines.map((l) => l.confidenceState);
        for (const l of quote.lines) {
          tally[l.confidenceState] = (tally[l.confidenceState] ?? 0) + 1;
          detail.push(
            `${l.confidenceState} · ${l.description.slice(0, 40)} · qty ${l.qty}` +
              (l.unitPrice != null ? ` · $${l.unitPrice.toFixed(2)}` : " · not priced"),
          );
        }
      } catch (err) {
        detail.push(`ERROR: ${(err as Error).message}`);
      }
      rows.push({ rfq: r.id, shape: r.shape, states, detail });
    }

    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    const pct = (n: number) => (total ? ((n / total) * 100).toFixed(1) : "0.0");

    if (markdown) {
      console.log(
        `Corpus: ${QUOTE_SUMMARY(await corpusStats(db.prisma, workspace.id))}` +
          (withCostRecords ? ", cost records loaded" : ", **no cost records**"),
      );
      console.log("");
      console.log("| State | Lines | % of lines |");
      console.log("|---|---:|---:|");
      for (const s of ["GREEN", "AMBER", "RED"]) {
        console.log(`| ${s} | ${tally[s] ?? 0} | ${pct(tally[s] ?? 0)}% |`);
      }
      console.log(`| **Total** | **${total}** | |`);
      console.log("");
      console.log("| RFQ | Input shape | Line outcomes |");
      console.log("|---|---|---|");
      for (const row of rows) {
        console.log(
          `| ${row.rfq} | ${row.shape} | ${row.detail.map((d) => d.replace(/\|/g, "\\|")).join("<br>") || "no lines extracted"} |`,
        );
      }
    } else {
      console.log(`\nCorpus: ${QUOTE_SUMMARY(await corpusStats(db.prisma, workspace.id))}\n`);
      for (const row of rows) {
        console.log(`${row.rfq}  ${row.shape}`);
        for (const d of row.detail) console.log(`      ${d}`);
      }
      console.log("\n--- confidence distribution ---");
      for (const s of ["GREEN", "AMBER", "RED"]) {
        console.log(`${s.padEnd(6)} ${String(tally[s] ?? 0).padStart(4)}  ${pct(tally[s] ?? 0)}%`);
      }
      console.log(`TOTAL  ${String(total).padStart(4)}`);
    }
  } finally {
    await db.close();
  }
}

async function corpusStats(
  prisma: Awaited<ReturnType<typeof openScratchDb>>["prisma"],
  workspaceId: string,
) {
  const lines = await prisma.historicalQuoteLine.findMany({
    where: { historicalQuote: { workspaceId } },
    include: { historicalQuote: true },
  });
  const items = new Set(lines.map((l) => l.partNumber ?? l.description));
  const dates = lines.map((l) => l.historicalQuote.quotedAt.getTime());
  return {
    lines: lines.length,
    items: items.size,
    from: new Date(Math.min(...dates)).toISOString().slice(0, 10),
    to: new Date(Math.max(...dates)).toISOString().slice(0, 10),
  };
}

const QUOTE_SUMMARY = (s: { lines: number; items: number; from: string; to: string }) =>
  `${s.lines} priced historical lines, ${s.items} distinct items, ${s.from} → ${s.to}`;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
