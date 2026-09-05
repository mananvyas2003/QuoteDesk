# K3 backtest — input format and how to run it

PRD §2 kill criterion **K3**: *drafted line price vs what the estimator would
have quoted, within ±10% on ≥70% of lines.* Fail it and the pricing signal is
not in the history; narrow the vertical or kill.

This harness is the only thing in this repo that can produce a number for K3. It
must be run on a **real shop's export**. It refuses to run on the demo corpus.

```bash
npm run backtest -- --data ./path/to/export.csv
npm run backtest -- --data ./path/to/export.json --out reports/k3-backtest.md
npm run backtest -- --workspace <workspaceId>        # an already-loaded corpus
```

Options:

| Flag | Meaning |
|---|---|
| `--data <path>` | A `.csv` or `.json` export. Loaded into a throwaway database; your `dev.db` is never touched. |
| `--workspace <id>` | Backtest a corpus already in `DATABASE_URL`. Refused if the workspace is the demo corpus. |
| `--out <path>` | Report destination. Default `reports/k3-backtest.md`. |
| `--limit <n>` | Hold out only the `n` most recent priced lines instead of all of them. The **whole** corpus is still used to predict each one. Use this for a fast first look on a large export; the report states when a sample was used. |

## CSV format

One row per **priced quote line**. Header row required; column order does not
matter; unknown columns are ignored.

```csv
quote_number,quoted_at,account_name,account_domain,part_number,description,material,finish,tolerance,revision,qty,unit_price,sku,spec_hash,cost_index,outcome,competitor_price
Q-4412,2025-11-04,Acme Industrial,acmeindustrial.example,BP-1218,Base plate 12x18x0.5,A36,powder coat black,±1/16,Rev C,50,48.50,FAB-BP-1218,,,won,
Q-4412,2025-11-04,Acme Industrial,acmeindustrial.example,GB-88,Guard bracket laser cut,A36,powder coat black,±1/16,Rev B,100,12.75,FAB-GB-88,,,won,
Q-4350,2025-06-04,Acme Industrial,acmeindustrial.example,BP-1218,Base plate 12x18x0.5,A36,powder coat black,±1/16,Rev C,100,46.90,FAB-BP-1218,,,lost,45.00
```

| Column | Required | Notes |
|---|---|---|
| `quote_number` | yes | Groups lines into one quote. `same as PO 4471` resolution matches on this value, so keep the shop's own prefixes (`PO-4471`, not `4471`). |
| `quoted_at` | yes | `YYYY-MM-DD` or any date `Date` can parse. The backtest predicts each line using **only** comparables quoted on or before this date. |
| `unit_price` | yes | The actual price quoted. This is the target the prediction is scored against. |
| `qty` | yes | Quantity for this line. Quantity is the dominant price curve; a corpus without varied quantities cannot be backtested meaningfully. |
| `description` | yes | Free text. Used for near-match scoring when there is no part number. |
| `part_number` | no | The strongest match signal. Coverage here largely determines the GREEN rate. |
| `material`, `finish` | no | Feed the confidence gate. Absent → assumable blockers → AMBER. |
| `tolerance`, `revision` | no | Also feed the gate. A corpus with no `revision` can never produce a GREEN line, because an unstated revision on a part-numbered line is an assumable blocker. If your export has no revision column, expect GREEN = 0 and read the blocker table rather than the headline number. |
| `sku` | no | Used to join a `CostRecord`. |
| `spec_hash` | no | Alternative cost join key. |
| `cost_index` | no | Material cost index at quote time. When present on both a comparable and the newest line, older prices are back-adjusted. Leave blank if the shop has no index — none is invented. |
| `account_name`, `account_domain` | no | Account-scoped comparables are weighted higher than workspace-wide ones. |
| `outcome` | no | `won` \| `lost` \| `no_decision`. Blank means unrecorded, which is **not** treated as evidence of a bad price. |
| `competitor_price` | no | On a lost line, the price that beat you. Used as a censored upper bound. |

### Optional cost records

Margin cannot be checked without cost. Supply a second file:

```bash
npm run backtest -- --data export.csv --costs costs.csv
```

```csv
sku,spec_hash,unit_cost,as_of_date,source
FAB-BP-1218,,28.00,2026-08-01,vendor_list
FAB-GB-88,,7.10,2026-08-01,erp_export
```

`source` is one of `vendor_list`, `manual`, `erp_export`.

Without cost records every line reports unknown margin. Because
`workspace.requireCostForGreen` defaults to true, that means **no line can be
GREEN**, and the report will say so. That is the correct behaviour, not a bug:
an unverifiable margin must not pass silently.

## JSON format

Either a bare array of line objects, or `{ "lines": [...], "costs": [...] }`.
Keys are the CSV column names in either `snake_case` or `camelCase`.

```json
{
  "lines": [
    {
      "quoteNumber": "Q-4412",
      "quotedAt": "2025-11-04",
      "accountName": "Acme Industrial",
      "partNumber": "BP-1218",
      "description": "Base plate 12x18x0.5",
      "material": "A36",
      "finish": "powder coat black",
      "qty": 50,
      "unitPrice": 48.5,
      "sku": "FAB-BP-1218",
      "outcome": "won"
    }
  ],
  "costs": [{ "sku": "FAB-BP-1218", "unitCost": 28.0, "asOfDate": "2026-08-01", "source": "vendor_list" }]
}
```

## Method

Leave-one-out. For each held-out priced line, the harness predicts its unit
price from the rest of the corpus through the **exact production path**:

```
resolveAgainstHistory(...,  { excludeHistoricalLineIds: [line.id], asOf: line.quotedAt })
  -> priceFromCandidates(candidates, line.qty, { now: line.quotedAt, currentCostIndex })
  -> evaluateConfidence({ ..., now: line.quotedAt })
```

There is no separate scoring implementation. If the backtest and production
diverged, the backtest would be worthless.

`asOf` matters: a prediction may only use comparables that existed when the line
was quoted. Without it the harness would be scoring itself on data from the
future and the number would be optimistic and meaningless.

## Two caveats that limit what this number means

1. **It measures price resolution, not extraction.** Input lines are already
   structured, so `extractConf` is fixed at 1.0. A real inbound RFQ arrives as a
   scanned print or an email thread and must be parsed first. K3 measured here
   is an upper bound on end-to-end accuracy.
2. **The held-out price is what the shop quoted, not what the job was worth.**
   K3 asks whether the drafted price matches what the estimator would have
   quoted — which is exactly what this measures — but a shop's historical price
   can itself be wrong. Outcome data (`outcome`, `competitor_price`) is the only
   corrective, and most exports will not have it.

## Reading the report

- The **distribution** (p10/p50/p70/p90/p99) of relative error, not the mean.
  The mean hides the tail that bankrupts a shop.
- **% within ±10%**, stated PASS or FAIL against the K3 threshold of ≥70%.
- Error by **quantity bucket** and by pricing **method** — this is how you find
  out whether quantity-aware pricing actually worked.
- Error **within GREEN specifically**. A wrong GREEN line is a far more serious
  failure than a high RED rate: RED asks a question, GREEN sends a price.
- Lines that could not be predicted at all, grouped by blocker code.

Do not tune a threshold to make this report pass. If GREEN error is worse than
AMBER error, the report says so, and that finding is worth more than a green
tick.
