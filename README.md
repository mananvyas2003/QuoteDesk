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
- Deterministic extraction from the email body, plus multimodal extraction from
  attached drawings and PDFs; historical price-basis resolution on top
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
| `GEMINI_API_KEY` | no | Reads attached drawings. Free tier at [aistudio.google.com](https://aistudio.google.com). |
| `ANTHROPIC_API_KEY` | no | A second opinion on borderline classifications, and reading drawings when selected. |
| `DOCUMENT_MODEL_PROVIDER` | no | `anthropic`, `gemini`, or `none`. Unset → the first provider with a key, in that order. |
| `GEMINI_MODEL` | no | Pinned to `gemini-3.6-flash`. A moving alias would change behaviour silently. |
| `DOCUMENT_MAX_COUNT`, `DOCUMENT_MAX_BYTES` | no | Caps on documents read per RFQ (default 5) and per-document size (default 8MB). |

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

- **No CAD geometry.** A `.step` / `.dwg` / `.dxf` attachment is recorded and
  reported as unread, never silently ignored. PDFs and images are read (see
  [Reading attached drawings](#reading-attached-drawings)).
- **No auto-send.** The only outbound mail path notifies the shop's own
  estimator, and it refuses structurally to address the RFQ's sender.
- **No IMAP polling.** Webhook only.

## Reading attached drawings

Most fabrication RFQs carry the ask in the email body and the specification in
an attached print: *"20 off PN-4471, need it in three weeks"* with the material,
finish, tolerance and revision sitting in the drawing's title block. Neither half
is enough on its own to reach GREEN.

At ingest, PDF and image attachments are read (`src/lib/documents`) and what they
say is folded into what the body said:

- **A document line that matches a body line enriches it**, keyed on part number,
  falling back to a strict description match. It does not become a second line.
- **The body wins where both speak.** A value the buyer typed was written by the
  buyer; a value read off a drawing was read by a model.
- **A drawing that contradicts the email quantity raises `qty_conflict`** and the
  line goes RED. We cannot tell which one applies, so we do not guess.
- **A part only the drawing mentions becomes its own line**, quantity 1 unless the
  drawing states otherwise.

### What keeps it honest

- **A field read at low legibility is discarded, not carried.** An absent material
  raises the existing `missing_material` blocker, so the line goes AMBER with a
  published assumption the estimator confirms. A kept low-confidence value would
  instead have produced a confidently wrong GREEN. The asymmetry between those two
  outcomes sets the direction of every threshold in `EXTRACTION_CONFIDENCE`.
- **No model output becomes a price.** The extractor is forbidden a price by both
  its response schema and its prompt. It emits the same `ExtractedFields` shape the
  text parser emits, and it passes through the same confidence gate. No new blocker
  code was added.
- **Nothing is extracted that cannot be cited** (PRD §5.1). Every field carries a
  `SourcePointer` naming the file, the page and a verbatim snippet.
- **The document is untrusted data.** A drawing comes from an outside party;
  instructions inside it are content, never commands, and the prompt says so.
- **It is an enhancement, never a dependency.** No key, a timeout or a malformed
  reply means attachments are recorded as unread *with the reason shown on the RFQ*
  and the draft proceeds from the body alone. An estimator told nothing would
  assume the drawing was understood.
- **Caps are enforced before bytes are read**: 5 documents per RFQ, 8MB each.
- **Specs are canonicalised through the same recognisers the body parser uses.**
  A title block reading `MATERIAL: ASTM A36 HR PLATE, 0.250 THK` becomes `A36`.
  Without that step the capability envelope compares a raw title-block string
  against a list of canonical materials and sends a quotable line to RED for a
  reason that has nothing to do with the part — a worse failure than not reading
  the drawing, because it looks like a considered judgement. A value no
  recogniser knows is kept verbatim so the envelope can fail it honestly.

### Providers

Two are implemented behind one `DocumentExtractor` seam, sharing a single
prompt and normalisation (`src/lib/documents/prompt.ts`) so they cannot drift on
what "extracted" means. Only the wire format differs.

| | |
|---|---|
| **Gemini** | `GEMINI_API_KEY`. Free tier, no card, native PDF input. REST, no SDK dependency. Retries 429/503 — the free tier returns "high demand" routinely, and without a retry a drawing would fail to be read for reasons unrelated to the drawing. |
| **Anthropic** | `ANTHROPIC_API_KEY`. Native PDF input via the official SDK. |

A note on data terms: Gemini's free tier may use prompts to improve Google
products. That suits development. A shop's real customer drawings are usually
the buyer's IP and frequently under NDA, so a pilot needs paid terms, a
zero-retention option, or a self-hosted model.

### Try it

```bash
npm run mail:fixture -- scripts/fixtures/sample-rfq-with-drawing.eml
```

The email body states only the part number, description and quantity. The
attached PDF's title block supplies material, finish, tolerance and revision.
With no key configured the same command still drafts, reporting the attachment
as unread.

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
| §5.1 Scanned raster / title-block extraction | Done — multimodal, needs `ANTHROPIC_API_KEY` | [document-extract.test.ts](tests/document-extract.test.ts) and [inbound-email.test.ts](tests/inbound-email.test.ts) — `an attached drawing supplies the spec the email left out` |
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

- **Cost from geometry.** Drawings are read for their *specification* (material,
  finish, tolerance, revision, quantities). Deriving a *routing* from geometry —
  cut path length, pierce count, bend count, weld inches — and pricing from it is
  not built, and is frozen: it is a new price-derivation input. This is the
  structural cap on the GREEN rate, since a line can only be priced today if the
  shop has quoted something comparable before. See [ROADMAP.md](ROADMAP.md).
- **CAD geometry files.** `.step`, `.dwg`, `.dxf` and friends are recorded and
  reported as unread.
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

Two scoped overrides are recorded there: inbound email ingest, and reading
attached drawings. Neither touched the pricing or confidence path.

[ROADMAP.md](ROADMAP.md) is the ordered list of what is still missing — most of
it deliberately blocked behind that same K3 measurement, with the reason stated
per item.
