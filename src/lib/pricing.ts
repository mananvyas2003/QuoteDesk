/**
 * Every tunable in the pricing path, in one place.
 *
 * ⚠ THESE NUMBERS ARE UNVALIDATED GUESSES. None of them was measured against a
 * real shop's outcomes, because this repo has never been run on a real corpus.
 * They are starting points chosen to be conservative, and every one of them is
 * to be replaced with a value measured from `scripts/backtest.ts` output and
 * from recorded win/loss data. Do not cite any of them as evidence.
 */
export const PRICING_CONFIG = {
  /**
   * Task 4 — comparables are *quoted* prices, including quotes that lost
   * because the price was too high. Weighting by recorded outcome stops the
   * derived price regressing toward prices with no established relationship to
   * what wins.
   *
   * `unknown` stays at 1.0 deliberately: most historical data carries no
   * outcome, and absence of an outcome is not evidence of a bad price.
   *
   * [Guessing] — replace with measured win-rate-by-margin data.
   */
  outcomeWeights: {
    won: 1.0,
    no_decision: 0.5,
    lost: 0.15,
    unknown: 1.0,
  } as Record<string, number>,

  /**
   * Task 5 — exponential decay on comparable age. A 20-month-old price and last
   * month's price should not carry equal weight when material cost moves.
   *
   * [Guessing] — replace with a half-life fitted to the shop's own price drift.
   */
  recencyHalfLifeMonths: 9,

  /**
   * Task 3b — customer-specific pricing is real, so an account's own history
   * outweighs workspace-wide history for the same item. Workspace-wide
   * comparables are still used; an empty account history must never mean an
   * empty pool.
   *
   * [Guessing]
   */
  scopeWeights: {
    account: 1.0,
    workspace: 0.6,
  } as Record<string, number>,

  /** Task 2 — quantity-curve fitting. */
  qty: {
    /** Minimum comparables before a log-log fit is attempted. */
    minComparablesForFit: 4,
    /** Minimum max/min quantity spread before a fit is meaningful. */
    minQtyRatioForFit: 2,
    /**
     * Reject the fit if the slope is above this. Unit price rising with volume
     * is almost certainly bad data, not a real curve.
     */
    maxAcceptedSlope: 0.05,
    /** Reject the fit below this r². */
    minAcceptedR2: 0.5,
    /** Beyond this multiple outside the observed range: AMBER, delta stated. */
    extrapolationAmberRatio: 3,
    /**
     * Beyond this multiple outside the observed range: RED. Do not extrapolate
     * a setup-cost curve two decades beyond the data.
     */
    extrapolationRedRatio: 10,
  },

  /**
   * Task 3a — explicit scan caps. The previous code used `take: 500` with no
   * ordering, silently truncating the corpus to an arbitrary 500 rows. These
   * caps are ordered by recency and any truncation is surfaced as a blocker.
   */
  retrieval: {
    accountScanCap: 5_000,
    workspaceScanCap: 20_000,
    /** Candidates kept after scoring. */
    scoredPoolCap: 24,
  },
} as const;

/** Exponential decay weight for a comparable of a given age. */
export function recencyWeight(ageMonths: number, halfLifeMonths: number): number {
  if (!(ageMonths > 0)) return 1;
  return Math.pow(0.5, ageMonths / halfLifeMonths);
}
