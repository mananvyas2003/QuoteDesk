# FREEZE

**This repository is feature-frozen.**

## Recorded override: email-native ingest and notification

The owner explicitly overrode this freeze once, for **inbound email ingest and
estimator notification only**. That work is merged. It is recorded here rather
than quietly folded in, so the freeze's history stays auditable.

What the override covered: an inbound-parse webhook, RFQ detection, the bridge
into the existing ingest → draft pipeline, estimator notification, and the
operator screens for them. It added `InboundEmail` and `Notification` models, an
`/inbound` page, an `/api/inbound-email` route, and `@anthropic-ai/sdk` for an
optional borderline classifier.

What it did **not** touch, deliberately:

- `CONFIDENCE_THRESHOLDS` and `PRICING_CONFIG` — byte-identical.
- No new pricing mechanism, no new comparable source, no new blocker code.
  Classification decides only whether the existing pipeline runs at all.
- `src/lib/{resolve,pricing,confidence,draft,extract}.ts` — unmodified.

## Recorded override: reading attached drawings and PDFs

The owner overrode this freeze a second time, for **document extraction only**.
Recorded here for the same reason as the first: the freeze history stays
auditable rather than quietly eroding.

What it covered: reading PDF and image attachments at ingest time
(`src/lib/documents`), a multimodal extraction path, and folding what a drawing
says into what the email body said. Most fabrication RFQs carry the ask in the
body and the specification in an attached print, and until this landed the
attachment bytes were written to disk and never opened.

Why it does not compromise the measurement this freeze exists to protect:

- **Extraction is upstream of pricing.** It changes which specification fields
  exist on a line, not how a price is derived from them. `resolve.ts`,
  `pricing.ts`, `confidence.ts`, `draft.ts`, `cost.ts`, `extract.ts` and
  `types.ts` are byte-identical, and the K3 backtest runs over a historical
  corpus that never passes through this path at all.
- **No new blocker code.** A field read at low legibility is *discarded*, so the
  existing `missing_material` / `missing_finish` blockers fire naturally. A
  barely legible line carries the existing `degraded_input`; a drawing that
  contradicts the email quantity carries the existing `qty_conflict`.
- **No new Prisma model or column, and no migration.**
- **No model output can become a price.** The extractor is forbidden a price by
  both its schema and its prompt, and produces only the `ExtractedFields` shape
  the text parser already produced.
- **It is an enhancement, never a dependency.** With no API key, a timeout, or a
  malformed reply, the attachments are recorded as unread with a stated reason
  and the RFQ is drafted from the body alone — exactly the previous behaviour.

Evidence: `tests/document-extract.test.ts` (18 tests) and two end-to-end tests
in `tests/inbound-email.test.ts`.

---

Neither override changes the reasoning below, and the lift condition is still
the only thing that ends the freeze. K3 remains unmeasured. What is still
blocked, and the order it should be built in once K3 is measured, is in
[ROADMAP.md](ROADMAP.md).

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
- **OCR / document reading** — *lifted for the second recorded override above.*
  Reading a drawing for its specification is built. Deriving a *routing* from
  its geometry (cut length, bend count, weld inches) is a new price-derivation
  input and remains frozen.
- **Email / IMAP ingest** — *lifted for the recorded override above.* Inbound
  webhook ingest is built; IMAP polling and outbound quote sending are not, and
  remain frozen.
- **New pages or Prisma models**, beyond those the recorded override added.

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
