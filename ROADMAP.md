# ROADMAP — what is missing, in the order it should be built

This list comes from a gap review of the whole platform. It is ordered by
**what unblocks what**, not by effort. Each item says whether
[FREEZE.md](FREEZE.md) permits it today.

The organising judgement: QuoteDesk currently prices **by analogy** (find
similar past lines, fit a quantity curve) and reads **email bodies only**. Those
two facts, together, cap it at the fraction of inbound that is both a repeat
part and pasted as text. Everything below is aimed at those two ceilings and at
the fact that nothing the estimator does today makes the system better tomorrow.

---

## P0 — Gap zero: measure K3

Nothing else on this list is worth trusting until this is done.

- [ ] **Load a real shop corpus** (≥300 lines / ≥50 items) via the format in
      [scripts/BACKTEST.md](scripts/BACKTEST.md).
- [ ] **Run `npm run backtest`** and write the measured result into
      `reports/k3-backtest.md`, replacing **UNMEASURED**.
- [ ] **Read the result against the constants.** If analogy pricing fails K3,
      the process-based path (P2) becomes urgent rather than additive.

*Freeze: this is the condition that lifts the freeze. It is not a code change.*
**Blocked on the owner supplying real quote history. I cannot substitute for it —
the harness deliberately refuses demo and seed-signature data.**

---

## P1 — Read the drawing, not just the email  ← building now

70–80% of real fab RFQs arrive as a PDF or a scanned print. Today
`storeAttachments` writes the bytes to disk and
[nothing ever opens them](src/lib/inbound.ts), so `ingestRfq` sees only the mail
body. This is the single largest gap between the demo and a shop's actual inbox.

- [ ] Attachment → document text/spec extraction, with page + snippet citations.
- [ ] Multimodal (Claude vision) path for scanned prints and title blocks, since
      a raster print has no text layer at all. **This is where AI is mandatory.**
- [ ] Every extracted field carries a confidence and a `SourcePointer`
      (`page`, `snippet`, `bbox`) — PRD §5.1: extract nothing you cannot cite.
- [ ] Low-confidence extraction maps onto the **existing** blocker model
      (`degraded_input`, `missing_material`, …). No new blocker codes.
- [ ] Merge document lines with body lines; contradictions raise the existing
      `qty_conflict`.
- [ ] Hard guards: size/page/count caps, document content framed as untrusted
      data, and no path by which a model output becomes a *price*.

*Freeze: permitted as a scoped, recorded override. Extraction sits **upstream**
of pricing — it changes what fields exist, not how a price is derived — so it
cannot perturb the K3 baseline. `CONFIDENCE_THRESHOLDS`, `PRICING_CONFIG`,
`resolve.ts`, `pricing.ts`, `confidence.ts` and `draft.ts` stay byte-identical.*

---

## P2 — Price from process, not only from analogy

The structural ceiling. A line can only reach GREEN today if the shop has
quoted that part before, so the automation rate is capped by repeat-part
frequency — roughly a third of a job shop's lines.

- [ ] Derive a **routing** from the drawing: material + thickness, cut path
      length, pierce count, bend count, weld inches, finish area, hardware.
- [ ] **Calibrate machine rates and setup times from the shop's own won quotes**
      by regression — not from a rate card typed into a form.
- [ ] Emit a **provenance chain** for every price (each line item traced to a
      comparable or to a calibrated rate, with its uncertainty), because the
      controller is who kills pilots (PRD §3).
- [ ] Material yield / nesting efficiency — a dominant sheet-metal cost driver,
      absent today.

*Freeze: **blocked.** This is a new price-derivation method. FREEZE.md's
argument applies exactly: adding it before K3 makes a K3 failure unattributable.
Build after P0.*

---

## P3 — Close the learning loop

Today the loop is open, so the product cannot improve and there is no
compounding asset:

- `EditEvent` records field, old value, new value and reason code, and
  **nothing consumes it**.
- `Outcome` is captured on app-generated quotes, but only `HistoricalQuote`
  rows feed the comparable pool — so a won QuoteDesk quote never improves the
  next one.

- [ ] Feed accepted/edited app quotes back into the comparable pool.
- [ ] Treat estimator edits as labelled training signal for the shop's pricing
      function.
- [ ] Weekly drift report: "stainless quotes ran 6% under realised cost."

*Freeze: **blocked.** Explicitly "new comparable sources". After P0.*

---

## P4 — Answer the question behind the RFQ

- [ ] **Bid / no-bid recommendation** from win-rate, margin and customer
      behaviour: quoting everything is how a shop wins the jobs it priced wrong.
- [ ] **Price-to-win** band from outcome history and known competitor prices.
- [ ] **Real lead time.** `draft.ts` hardcodes `leadDays: 14`. In fabrication
      lead time is often the deciding variable, not price.

*Freeze: **blocked** (new confidence/pricing inputs). After P0.*

---

## P5 — Make it a product a second customer can use

Unglamorous, currently absolute blockers on selling to anyone:

- [ ] **Multi-tenancy.** `getWorkspaceContext` returns the first workspace row.
- [ ] **Authentication.** There is none.
- [ ] **Learned capability envelope** — infer max thickness by material and
      tolerance class by process from what the shop has actually built, instead
      of a static comma-separated materials list in Settings.

*Freeze: new models/pages, so a recorded override — but none of it touches
pricing. Sequence after P1; it is a prerequisite for a real pilot, not for
measurement.*

---

## P6 — The network layer

- [ ] Anonymised cross-shop cost/price benchmarks per item class (PRD §10
      Phase 3). This is the part that is defensible at scale; it earns its place
      only once single-player is measured and working.

---

## Deliberately not on this list

ERP, scheduling, CRM, 3D CAD cost modelling, a buyer-side marketplace, and
auto-sending quotes to customers. The last one is a **hard product constraint**,
not a sequencing decision: a quote never leaves without human approval.
