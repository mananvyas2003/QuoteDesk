# QuoteDesk

AI estimator that answers inbound RFQs for metal fabrication shops.

V1 implements the three PRD features: **ingest → draft (GREEN/AMBER/RED) → approve / send / learn**.

> K3 (PRD §2) is **unmeasured**. No real shop corpus has been loaded. See
> [reports/k3-backtest.md](reports/k3-backtest.md).

That is not a formality. PRD §2's K3 kill criterion — drafted price within ±10%
on ≥70% of lines — requires a real shop's quote history. The harness exists
(`npm run backtest`), and it refuses to produce a number from synthetic data.
Until a real corpus runs through it, nothing here establishes that the pricing
signal is in the history.

**This repo is feature-frozen.** See [FREEZE.md](FREEZE.md) for what that
allows and the single condition that lifts it.

## Stack

- Next.js 16 (App Router) + TypeScript + Tailwind
- Prisma 5 + SQLite (local). Swap `DATABASE_URL` to Postgres for production.
- Deterministic extraction + historical price-basis resolution (multimodal OCR can replace the extractor later)
- Tests: `node:test` + `tsx`, no extra dependencies

## Setup

```bash
npm install
npx prisma migrate dev
npm run dev
```

The app **fails loudly** on a workspace with no historical corpus, quoting PRD
§7's "no history, no onboarding" rule, rather than rendering an empty inbox.
Either import real history at `/onboarding`, or load the synthetic demo:

```bash
npm run db:seed -- --demo
```

The `--demo` flag is required. The corpus it loads is invented; the workspace is
flagged `isDemo`, banners itself on every page as *"Demo corpus — prices are
synthetic. Not valid for evaluation."*, and is refused by the backtest harness.

## Demo path

1. **Inbox** — RFQ list + answer coverage
2. **Ingest** — paste an email → extract lines with per-field source pointers → auto-draft
3. **Review** — source left / draft right; price basis shows the pricing method and the quantity range used; edit prices (captured as training signals); confirm AMBER assumptions; copy-out or mark sent
4. **Outcome** — after send, record won / lost / no decision
5. **Settings** — margin floor, capability envelope, and the require-cost-for-GREEN gate (controller controls)
6. **History** — priced-line corpus used for price basis

## PRD alignment

State of `main` as merged (`cdf2db4`), verified by the run recorded in
[reports/01-post-merge.md](reports/01-post-merge.md): 51 tests pass, lint clean,
build clean, 8 migrations with none pending.

Every "Done" links to the test or report that proves it. Nothing is marked Done
on the strength of the demo rendering.

| Feature | Status | Evidence |
|---|---|---|
| §5.1 Ingest, line extraction, per-field source pointers | Done — text/table paste only | [green-reachability.test.ts](tests/green-reachability.test.ts) (`every extracted spec field carries a source pointer`, title-block header specs) |
| §5.1 Reconcile a body statement against a differing line table, surface the conflict | Done | [retrieval.test.ts](tests/retrieval.test.ts) (`3d: a same-as note alongside a line table is a conflict`) |
| §5.1 Resolve "same as PO 4471 but 400 units" | Done | [reports/00-baseline.md](reports/00-baseline.md) R05; quote-number normalisation in [extract.ts](src/lib/extract.ts) |
| §5.2 Priced / assumptions / decline / clarify | Done | [green-reachability.test.ts](tests/green-reachability.test.ts) (`an unassumable blocker forces RED and a clarification, never a price`) |
| §5.2 Quantity-break pricing | Done | [pricing.test.ts](tests/pricing.test.ts); each break priced independently, line takes the worst state |
| §5.3 Approve, edit capture, outcome | Done — UI + `edit_event` / `outcome` persistence | Not covered by an automated test; verified by hand only |
| §5.4 Confidence gating, GREEN reachable | Done | [green-reachability.test.ts](tests/green-reachability.test.ts) — permanent regression guard; [00-baseline.md](reports/00-baseline.md) → [01-post-merge.md](reports/01-post-merge.md) (GREEN 0 of 17 → 4 of 18, measured on merged `main`) |
| §5.4 Margin-floor override rule | Done | [margin-floor.test.ts](tests/margin-floor.test.ts) — above floor → GREEN, below → AMBER with the margin stated, no cost record → AMBER |
| §5.4 Quantity-aware pricing | Done | [pricing.test.ts](tests/pricing.test.ts) — monotonic in quantity; qty 50,000 against a 10–500 corpus returns RED, not a number |
| §6 Data model | Done, extended | `CostRecord`, `HistoricalQuote.outcome`/`competitorPrice`, `HistoricalQuoteLine.costIndex`/`tolerance`/`revision`, `PriceBasis.method`/qty range/fit diagnostics, `QuoteLine.marginPct` |
| §7 Cold start / onboarding gate | Done | [demo-guard.test.ts](tests/demo-guard.test.ts) — empty non-demo corpus fails loudly, citing §7 |
| §2 K3 backtest harness | Done | [backtest.test.ts](tests/backtest.test.ts) — runs end-to-end, refuses demo and seed corpora |
| **§2 K3 threshold itself (±10% on ≥70%)** | **Not measured** | [reports/k3-backtest.md](reports/k3-backtest.md) — requires a real shop's export |
| §5.1 Scanned raster / title-block OCR | Not implemented | — |
| Email / IMAP ingest | Not implemented | — |

### Confidence thresholds

`CONFIDENCE_THRESHOLDS` in [src/lib/types.ts](src/lib/types.ts) is N = 3
comparables, M = 12 months, CV = 15%, near-match 0.75, exact 0.92.

**These are the PRD's own [Guessing] placeholders, not measured values.** The
previous version of this table presented them as if the gating row had been
validated at those numbers. Nothing has validated them. `PRICING_CONFIG` in
[src/lib/pricing.ts](src/lib/pricing.ts) (outcome weights, 9-month recency
half-life, quantity-fit acceptance bounds, scope weights) carries the same
caveat in a comment at the top of the file. Replace all of them with values
measured from `npm run backtest` on a real corpus, per PRD §5.4.

## Known not implemented

Named explicitly so the demo cannot imply otherwise.

- **Scanned raster / title-block OCR.** PRD §5.1 calls this "the actual moat
  work". Extraction is text and pipe-table only. A scanned print with an
  illegible title block correctly goes RED, but it goes RED because nothing
  reads it, not because a reader judged it illegible.
- **Email / IMAP ingest.** Ingest is paste and file-name only. The settings page
  displays an ingest address; nothing polls it.
- **Vendor-list and cost-record price bases.** `PriceBasis.sourceType` accepts
  `historical_quote | vendor_list | cost_record`, but only `historical_quote` is
  ever produced. The `VendorPrice` table is seeded and displayed, never priced
  from. Cost records feed the margin check only.
- **Cross-customer cost benchmarking** (PRD §10 Phase 3). Comparables never
  cross a workspace boundary.
- **ERP write-back** (PRD §4 non-goal in V1). Copy-out only.
- **Auto-tuned confidence thresholds per customer** (PRD §10 Phase 2).
- **App-generated quotes feeding back into the comparable pool.** `Outcome` is
  captured on quotes the app produces, but only `HistoricalQuote` rows are used
  as comparables, so the outcome loop does not yet close.
- **Multi-tenant anything.** `getWorkspaceContext` returns the first workspace.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local app |
| `npm test` | Full suite (51 tests) |
| `npm run backtest -- --data <path>` | K3 backtest on a real export — see [scripts/BACKTEST.md](scripts/BACKTEST.md) |
| `npm run confidence:dist` | Confidence-state distribution over 15 hand-written RFQs |
| `npm run confidence:dist -- --no-costs` | Same, with no cost records — shows what the GREEN cost gate costs |
| `npm run db:seed -- --demo` | Load the synthetic demo corpus (flag required) |
| `npm run db:studio` | Prisma Studio |
| `npm run build` | Production build |

## Reports

- [reports/00-baseline.md](reports/00-baseline.md) — GREEN was unreachable by
  construction (0 of 17 lines), the mechanism, and the post-fix distribution.
- [reports/01-post-merge.md](reports/01-post-merge.md) — the same instrument run
  on merged `main` (GREEN 4 of 18), plus the full verification run.
- [reports/k3-backtest.md](reports/k3-backtest.md) — K3 status: **unmeasured**.

## Freeze

The repo is feature-frozen. [FREEZE.md](FREEZE.md) states what is and is not
allowed, and the single condition that lifts it: a real shop corpus loaded and a
measured result in `reports/k3-backtest.md`.
