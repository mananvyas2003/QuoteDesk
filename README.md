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

**This repo is feature-frozen, with one recorded exception.** See
[FREEZE.md](FREEZE.md) for what the freeze allows and the single condition that
lifts it. Email-native ingest and estimator notification were built under an
explicit override of that freeze; nothing in the pricing or confidence path was
touched to do it.

## Stack

- Next.js 16 (App Router) + TypeScript + Tailwind
- Prisma 5 + SQLite (local). Swap `DATABASE_URL` to Postgres for production.
- Deterministic extraction + historical price-basis resolution (multimodal OCR can replace the extractor later)
- Tests: `node:test` + `tsx`, no test-framework dependency
- `@anthropic-ai/sdk`, used only for the optional borderline-RFQ classifier and
  lazily imported — the app runs fully without it configured

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

## Inbound email

An RFQ that arrives by email is detected, ingested, drafted and surfaced to the
estimator. **Nothing is ever sent to the buyer automatically** — a quote leaves
the building only when a human acts on the review screen.

```
provider inbound-parse  ->  POST /api/inbound-email
                              -> persist InboundEmail (dedupe on Message-ID)
                              -> classify: is this an RFQ?
                              -> ingestRfq -> draftQuoteForRfq   (existing pipeline)
                              -> notify the estimator, link to /rfqs/<id>
```

### V1 channel: inbound webhook

The chosen V1 approach is an **inbound-parse webhook**, not IMAP polling. It
needs no long-lived mailbox credentials, no poller process, and no OAuth, and
it is exercised end-to-end by a fixture in CI. Have the shop forward or
auto-forward their `quotes@` mailbox to an inbound-parse provider and point it
at `POST /api/inbound-email`.

Payload shapes accepted: **Postmark**, **SendGrid**, **Resend**, **Mailgun**, and
a raw MIME body. They are normalised to one internal shape before anything else
runs, so all providers and the local fixture share a single code path.

Authentication is a shared secret sent as `X-QuoteDesk-Secret` (or `?secret=`).
**The endpoint returns 503 until `INBOUND_WEBHOOK_SECRET` is set** — it will not
accept unauthenticated mail into the pricing pipeline.

### Env vars

See [`.env.example`](.env.example). The ones that matter:

| Variable | Required | Purpose |
|---|---|---|
| `INBOUND_WEBHOOK_SECRET` | to receive mail | Shared secret for the webhook. Unset → 503. |
| `INBOUND_STORAGE_DIR` | no | Where attachment bytes are written (default `storage/inbound`). |
| `NOTIFY_EMAIL` | no | Who gets the "draft ready" email. Defaults to the workspace estimator. |
| `NOTIFY_FROM_EMAIL`, `RESEND_API_KEY` | no | Outbound notification mail. Unset → in-app notification only, recorded as `not_sent:no_provider_configured`. |
| `APP_URL` | no | Base URL used in notification links. |
| `ANTHROPIC_API_KEY` | no | Optional second opinion on borderline classifications. Unset → rules-only, which is fully supported. |

### RFQ detection

`src/lib/rfqClassify.ts` runs deterministic rules first: explicit asks ("RFQ",
"please quote", "same as PO 4471"), supporting signals (quantity breaks, part
numbers, revisions, material specs, pipe tables), and negative signals (bounces,
auto-replies, marketing, remittance advice).

The bias is deliberately one-way and pinned by tests: **when in doubt, treat it
as an RFQ.** A missed RFQ costs the shop a job invisibly (PRD §1.3); a false
positive costs an estimator a few seconds reading a RED line. A negative signal
can lower certainty but cannot overrule an explicit ask — a purchase order that
also asks to price one extra line is still an RFQ for that line.

When `ANTHROPIC_API_KEY` is set, borderline verdicts (certainty 0.35–0.70) get a
second opinion from Claude. Confident verdicts never cost an API call. Any
failure — no key, no package, timeout, refusal — falls back to the rules verdict
rather than dropping mail. Email content is passed as delimited untrusted data
and the response is schema-constrained.

### Try it locally

```bash
npm run mail:fixture                                   # both bundled fixtures
npm run mail:fixture -- scripts/fixtures/sample-rfq.eml
npm run mail:fixture -- scripts/fixtures/sample-rfq.eml --webhook http://localhost:3000
```

Without `--webhook` it calls the same `receiveInboundEmail` the route calls;
with it, the HTTP layer and shared secret are exercised too. Re-running the same
fixture reports `duplicate` — proof the Message-ID dedupe holds.

Received mail, including everything skipped as not-an-RFQ and why, is listed at
**/inbound**.

### What inbound email does not do

- **No OCR.** Attachment bytes are stored and their metadata recorded; nothing
  reads them. A scanned print with no extractable body lines correctly produces
  a RED line asking the buyer for specs.
- **No auto-send.** The only outbound mail path notifies the shop's own
  estimator, and it refuses structurally to address the RFQ's sender.
- **No IMAP polling.** Webhook only.

## Demo path

1. **Inbox** — RFQ list + answer coverage
2. **Ingest** — paste an email → extract lines with per-field source pointers → auto-draft
3. **Review** — source left / draft right; price basis shows the pricing method and the quantity range used; edit prices (captured as training signals); confirm AMBER assumptions; copy-out or mark sent
4. **Outcome** — after send, record won / lost / no decision
5. **Settings** — margin floor, capability envelope, and the require-cost-for-GREEN gate (controller controls)
6. **History** — priced-line corpus used for price basis

## PRD alignment

State of `main`. The pricing correction pass is recorded in
[reports/01-post-merge.md](reports/01-post-merge.md) (51 tests at that point);
inbound email adds 17 more. Current: **68 tests pass**, lint clean, build clean,
9 migrations with none pending.

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
| §5.1 Email ingest (inbound webhook) | Done — webhook, not IMAP | [inbound-email.test.ts](tests/inbound-email.test.ts) — RFQ email drafts, duplicate Message-ID is a no-op, non-RFQ creates no quote |
| §5.1 RFQ detection | Done | [rfq-classify.test.ts](tests/rfq-classify.test.ts) — RFQ/non-RFQ fixtures, and the bias-to-review guard |
| §5.3 Estimator notified, never the buyer | Done | [inbound-email.test.ts](tests/inbound-email.test.ts) — `a notification is never addressed to the buyer` |
| IMAP mailbox polling | Not implemented | Webhook is the V1 channel |

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
- **IMAP / mailbox polling.** Inbound email arrives by webhook only
  (see [Inbound email](#inbound-email)). Nothing logs into a mailbox.
- **Outbound quote sending.** The estimator copies out or marks sent. The only
  outbound mail in the codebase notifies the shop's own estimator, and refuses
  structurally to address the buyer.
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
| `npm test` | Full suite (68 tests) |
| `npm run backtest -- --data <path>` | K3 backtest on a real export — see [scripts/BACKTEST.md](scripts/BACKTEST.md) |
| `npm run confidence:dist` | Confidence-state distribution over 15 hand-written RFQs |
| `npm run confidence:dist -- --no-costs` | Same, with no cost records — shows what the GREEN cost gate costs |
| `npm run mail:fixture` | Feed a local .eml through the inbound pipeline |
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
