# K3 — UNMEASURED

**No real dataset was supplied, so K3 has not been measured. Nothing in this
file is a K3 result.**

PRD §2 K3: *drafted line price vs what the estimator would have quoted, within
±10% on ≥70% of lines.* Only a real shop's quote history can establish that. The
harness exists and runs; the number does not.

## How to produce the real number

```bash
npm run backtest -- --data ./their-export.csv --costs ./their-costs.csv
```

Input format, options, method and caveats: [scripts/BACKTEST.md](../scripts/BACKTEST.md).
This overwrites this file with the measured report.

## What the harness does

Leave-one-out over the corpus. Each held-out priced line is predicted from the
remaining corpus through the **exact production path** —
`resolveAgainstHistory` → `priceFromCandidates` → `evaluateConfidence` — with no
parallel scoring implementation, and with the clock pinned to that line's own
quote date (`asOf`) so a prediction can never use data that did not exist when
the line was quoted.

It reports the relative-error **distribution** (p10/p50/p70/p90/p99, not the
mean), % within ±10% with an explicit PASS/FAIL against the 70% threshold, error
broken out by quantity bucket and by pricing method, the confidence-state
distribution, error **within GREEN specifically**, unpredictable lines grouped by
blocker code, and corpus size / date range / distinct item count.

## Refusals (verified by tests in `tests/backtest.test.ts`)

| Condition | Behaviour |
|---|---|
| No `--data` or `--workspace` | Exits 1: "K3 cannot be measured without real data." |
| Target workspace has `isDemo = true` | Exits 1. Demo prices are synthetic; any error measured against them is meaningless. |
| Data file matches the `prisma/seed.ts` quote-number signature | Exits 1. |
| Malformed row (non-positive qty/price, bad `outcome`) | Throws with the row number, rather than silently dropping the row. |

## Harness verification run — NOT a K3 measurement

To prove the harness runs end-to-end, it was run against
`scripts/fixtures/format-example.csv`, a **24-line invented file whose only
purpose is to document the input format**. Its prices were generated from a
formula. The numbers below describe that formula, not any shop's pricing, and
must never be cited as evidence about K3.

## Corpus

| | |
|---|---|
| Priced historical lines | 24 |
| Distinct items | 5 |
| Date range | 2025-10-03 → 2026-09-03 |
| Cost records | 5 |
| Margin floor | 25% |
| Cost required for GREEN | yes |
| Lines held out and scored | 24 |

PRD §7 puts the minimum viable corpus at ~300 priced lines and ≥50 distinct
items. **This corpus is below that minimum, so these numbers describe a starved system, not the product's ceiling.**

## K3 verdict

**FAIL** — 64.7% of predicted lines are within ±10% (K3 threshold: ≥70%).

## Relative error distribution

`|predicted − actual| / actual`, over the 17 lines that produced a price.
Percentiles, not the mean — the mean hides the tail that bankrupts a shop.

| p10 | p50 | p70 | p90 | p99 |
|---:|---:|---:|---:|---:|
| 0.0% | 0.0% | 20.8% | 43.4% | 49.0% |

**Within ±10%: 64.7%** of 17 priced lines.

## Confidence-state distribution

| State | Lines | Share |
|---|---:|---:|
| GREEN | 2 | 8.3% |
| AMBER | 15 | 62.5% |
| RED | 7 | 29.2% |

### Error within GREEN specifically

A wrong GREEN line is a far more serious failure than a high RED rate: RED asks
the buyer a question, GREEN sends a price with no human in the loop.

| State | Lines priced | p50 | p90 | Within ±10% |
|---|---:|---:|---:|---:|
| GREEN | 2 | 0.0% | 0.0% | 100.0% |
| AMBER | 15 | 0.0% | 45.3% | 60.0% |

> GREEN error is at or below AMBER error, which is the ordering the gate is supposed to produce.

## Error by quantity bucket

Whether quantity-aware pricing actually worked.

| Quantity | Lines | Priced | p50 | p90 | Within ±10% |
|---|---:|---:|---:|---:|---:|
| 10–99 | 16 | 11 | 0.0% | 30.9% | 63.6% |
| 100–999 | 8 | 6 | 0.0% | 44.4% | 66.7% |

## Error by pricing method

| Method | Lines | Priced | p50 | p90 | Within ±10% |
|---|---:|---:|---:|---:|---:|
| loglog_fit | 4 | 4 | 0.0% | 0.0% | 100.0% |
| nearest_qty | 9 | 9 | 0.0% | 34.5% | 55.6% |
| single_comparable | 4 | 4 | 19.9% | 46.3% | 50.0% |
| none | 7 | 0 | — | — | — |

## Lines that could not be predicted

7 of 24 lines produced no price. Grouped by blocker code (a line can carry several):

| Blocker | Lines |
|---|---:|
| `no_price_basis` | 7 |
| `no_resolvable_item` | 5 |
| `unknown_margin` | 5 |
| `unsupportable_quantity` | 2 |
| `thin_comparables` | 1 |
| `single_comparable` | 1 |

## What this number does not say

1. **It measures price resolution, not extraction.** Corpus lines are already
   structured, so `extractConf` is pinned at 1.0. A real inbound RFQ arrives as
   a scanned print or an email thread and must be parsed first. This is an upper
   bound on end-to-end accuracy.
2. **The target is what the shop quoted, not what the job was worth.** K3 asks
   whether the draft matches what the estimator would have quoted, which is what
   this measures — but a historical price can itself be wrong.
3. No threshold in `CONFIDENCE_THRESHOLDS` or `PRICING_CONFIG` was tuned
   against this report.

### What the verification run does establish

Only that the plumbing works: the parser, the leave-one-out loop, the temporal
`asOf` guard, cost joining, the confidence gate, and every required report
section including GREEN-specific error. It establishes nothing about pricing
accuracy.

Two structural findings came out of it, and both were fixed rather than reported
around:

1. `HistoricalQuoteLine` had no `tolerance` or `revision` column, so a backtest
   reconstructing fields from history tripped `missing_revision` on every line
   and **GREEN could never be measured at all** — the single most important cell
   in the report was structurally unreachable. Both columns were added.
2. Corpus lines are already structured, so `extractConf` is pinned at 1.0. K3
   measured this way is an upper bound on end-to-end accuracy: it measures price
   resolution, not extraction.
