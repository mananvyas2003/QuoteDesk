# FREEZE

**This repository is feature-frozen.**

## Why

Every mechanism currently in the pricing path carries unvalidated constants:

- the **log-log quantity fit** — its acceptance bounds (slope ≤ 0.05, r² ≥ 0.5),
  its minimum comparable count, and its minimum quantity spread
- **outcome weighting** — won 1.0, no_decision 0.5, lost 0.15
- **recency decay** — a 9-month half-life
- **cost joins and the margin gate** — the floor percentage, and the decision
  that unknown margin blocks GREEN
- the **confidence thresholds** themselves — N = 3 comparables, M = 12 months,
  CV = 15%, near-match 0.75, exact 0.92

Not one of these numbers was measured. They are the PRD's own **[Guessing]**
placeholders and reasoned defaults chosen to be conservative. They interact:
a comparable's weight is the product of its outcome, recency and scope factors,
and that weight feeds the quantity fit, whose output feeds the margin check,
whose result feeds the gate.

Adding another mechanism on top of that makes a future failure harder to
attribute to any one cause. When K3 comes back and the number is wrong, the
question will be *which* of these is wrong — and every mechanism added before
that measurement is one more candidate to eliminate, multiplied against all the
others it interacts with. The cheapest time to stop adding is now, before the
first real number exists.

This is not a claim that the current mechanisms are correct. It is a claim that
they are the smallest set worth measuring, and that measuring them is worth more
than extending them.

## The one condition that lifts the freeze

> A real shop corpus is loaded and `reports/k3-backtest.md` contains a measured
> result.

That is the whole condition. Not a partial corpus, not a synthetic one, not a
promising early signal — a measured K3 result from a real shop's quote history,
produced by `npm run backtest` (see [scripts/BACKTEST.md](scripts/BACKTEST.md)).

The harness refuses to run against the demo corpus or the `prisma/seed.ts`
signature precisely so that this condition cannot be satisfied by accident.

Until then, `reports/k3-backtest.md` reads **UNMEASURED**, and PRD §2's K3
kill criterion is unevaluated. PRD §2 is explicit that K3 is the one people skip.

## Not allowed during the freeze

- **New pricing mechanisms.** No additional price-derivation methods, no
  blending, no learned models, no new comparable sources.
- **New confidence signals.** No new blocker codes or gate inputs. The blocker
  model in `src/lib/types.ts` is closed for additions.
- **Any change to `CONFIDENCE_THRESHOLDS`** (`src/lib/types.ts`) **or
  `PRICING_CONFIG`** (`src/lib/pricing.ts`). Not tuning, not "improving", not
  rounding. They stay unvalidated until real data measures them — changing one
  now destroys the baseline the first measurement will be read against.
- **OCR** of scanned raster prints or title blocks.
- **Email / IMAP ingest.**
- **New pages or Prisma models.**

## Allowed during the freeze

- **Bug fixes, with a failing test attached.** Write the test that fails for the
  stated reason first, then fix it. A fix without a test that failed beforehand
  is a change, not a fix.
- **Documentation**, including reports.

Loading a real corpus and running the backtest is not a change to the repo — it
is the thing the freeze exists to make happen.

## Where the evidence lives

| File | What it establishes |
|---|---|
| [reports/00-baseline.md](reports/00-baseline.md) | GREEN was unreachable by construction: 0 of 17 lines, and the mechanism |
| [reports/01-post-merge.md](reports/01-post-merge.md) | Post-merge state of `main`: GREEN 4 of 18, full verification run |
| [reports/k3-backtest.md](reports/k3-backtest.md) | K3: **unmeasured** |
| [scripts/BACKTEST.md](scripts/BACKTEST.md) | The input format a shop's export must take, and the method |
