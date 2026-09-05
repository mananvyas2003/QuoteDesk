# 01 — Post-merge verification on `main`

`fix/pricing-and-gating` merged into `main` at commit `cdf2db4` (`--no-ff`, no
conflicts). This file records the confidence distribution measured **on merged
`main`**, so the before/after figures are visible on the default branch without
checking out a branch.

Pre-fix numbers and the mechanism behind them: [00-baseline.md](00-baseline.md).

## Did the merge preserve the post-fix distribution?

**Yes — identically.** The branch measured GREEN 4 / AMBER 9 / RED 5 of 18
lines. Merged `main` measures the same. `main` contained no commits the branch
lacked, so the merge was a clean fast-forward with no conflicts and nothing to
resolve; there was no opportunity for the distribution to drift.

| State | Pre-fix (`main` before merge) | Post-merge (`main` now) |
|---|---:|---:|
| GREEN | **0 (0.0%)** | **4 (22.2%)** |
| AMBER | 9 (52.9%) | 9 (50.0%) |
| RED | 8 (47.1%) | 5 (27.8%) |
| Lines extracted | 17 | 18 |

Line count rose by one because R08's "same as PO 4471 but 400 units" note is now
extracted alongside the line table rather than discarded, and lands RED on an
unassumable `qty_conflict` blocker.

## Verification commands on merged `main`

| Command | Result |
|---|---|
| `npx prisma generate` | Generated Prisma Client v5.22.0 |
| `npx prisma migrate deploy` | 8 migrations found; no pending migrations to apply |
| `npm run lint` | Clean, no output |
| `npm test` | **51 pass, 0 fail** |
| `npm run build` | Compiled successfully; 7 routes |

Note on the test count: the suite is **51 tests**, not 29. Nothing was deleted,
skipped or weakened to reach green — the count grew as each task added its own
guards, and the final run reports `skipped 0` / `todo 0`.

## Distribution, as measured

```

Corpus: 28 priced historical lines, 5 distinct items, 2025-12-05 → 2026-08-05, cost records loaded

R01  pipe table, fully specified
      AMBER · Base plate 12x18x0.5 · qty 50 · $48.60
R02  pipe table, finish not stated
      AMBER · Guard bracket laser cut · qty 100 · $12.76
R03  qty-first shorthand
      GREEN · Guard bracket laser cut · qty 100 · $12.76
R04  prose request
      AMBER · SS shaft collar 2in for a rebuild. · qty 40 · $23.26
R05  same-as prior PO
      AMBER · Same as PO-4471 · qty 400 · $21.80
R06  scanned drawing, no specs
      RED · See attached scan. Hard to read — please · qty 1 · not priced
R07  quantity breaks
      AMBER · Please price AC-33 angle clip 3x3x0.25 a · qty 100 · $4.04
R08  table plus contradicting same-as note
      AMBER · Weldment frame 24x36 · qty 25 · $367.84
      RED · Same as PO-4471 · qty 400 · not priced
R09  new account, no account history
      AMBER · Base plate 12x18x0.5 · qty 60 · $47.83
R10  quantity far outside history
      RED · Angle clip 3x3x0.25 PN AC-33 A36 · qty 50000 · not priced
R11  capability envelope violation
      RED · Housing shell Ti-6Al-4V titanium · qty 20 · not priced
R12  title-block header applying to table
      GREEN · Guard bracket laser cut · qty 200 · $11.51
R13  tight tolerance class
      AMBER · SS shaft collar 2in PN SC-200 SS304. · qty 80 · $22.28
R14  unknown part, no history
      RED · Hydraulic manifold block XZ-9931 · qty 10 · not priced
R15  multi-line mixed table
      AMBER · Base plate 12x18x0.5 · qty 40 · $49.55
      GREEN · Angle clip 3x3x0.25 · qty 500 · $3.17
      GREEN · Guard bracket laser cut · qty 150 · $12.01

--- confidence distribution ---
GREEN     4  22.2%
AMBER     9  50.0%
RED       5  27.8%
TOTAL    18
```

## The cost gate, measured on `main`

Same corpus with every cost record removed (`npm run confidence:dist -- --no-costs`):

```
      AMBER · Angle clip 3x3x0.25 · qty 500 · $3.17
      AMBER · Guard bracket laser cut · qty 150 · $12.01

--- confidence distribution ---
GREEN     0  0.0%
AMBER    13  72.2%
RED       5  27.8%
TOTAL    18
```

`workspace.requireCostForGreen` defaults to true, so with no resolvable cost the
margin cannot be checked against the floor and no line may be GREEN. The drop
from 4 to 0 is the gate working, not a regression.

## What this does not say

A 22.2% GREEN rate says the gate *can* reach GREEN on a corpus built to allow
it. It says nothing about whether any of those four prices is correct. The
corpus is invented. Pricing accuracy requires `scripts/backtest.ts` on a real
shop's export — see [k3-backtest.md](k3-backtest.md), where K3 is recorded as
**unmeasured**.
