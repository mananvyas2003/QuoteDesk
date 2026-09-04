# PRD — QuoteDesk (working name)

**An AI estimator that answers every inbound RFQ.**

Version 0.1 · Draft · Owner: [you]
Status: **gated** — see §2 Kill Criteria. Do not build §5 until §2 passes.

---

## 0. How to read this document

This PRD is deliberately front-loaded with the things that can kill the company, not the things that make it exciting. The two decisions that determine whether this product works — *can you obtain a shop's historical quote data* and *will an estimator trust a machine-drafted price* — are not product decisions. No amount of spec quality fixes a "no" on either.

Everything is tagged: **[Certain]** = grounded in cited research or logical necessity. **[Likely]** = strong inference. **[Guessing]** = filling a gap you must replace with real data.

---

## 1. Problem

### 1.1 One-sentence pitch
*You are not answering a third of the money that emails you.*

### 1.2 The problem
Industrial distributors, fabricators and contract manufacturers receive quote requests as unstructured inbound — forwarded email threads, scanned 2D prints, spreadsheets of part numbers, photos of a nameplate, "same as last time but 400 units." An estimator reads each one, hunts part numbers across an ERP and vendor lists, checks what was charged last time, and assembles a quote. Complex RFQs take **11.5 hours on average, of which only 18% is value-adding work** — the rest is searching for data, waiting on approvals, and coordinating across disconnected systems (Fictiv, 2025 State of Manufacturing Report). **[Certain]**

The result is a queue. **30–40% of inbound RFQ volume in manufacturing and distribution either receives a response after the buyer's decision window has closed, or receives no response at all** (Go Autonomous). **[Certain]**

### 1.3 Why it has never been fixed
The loss is invisible in every report the business runs. Shops track the RFQs they quoted and lost. Almost none track the RFQs that never got quoted, because the backlog was too deep and the deadline passed first. **[Certain]** A problem that does not appear in a monthly report does not get a budget line — which is also why no incumbent has been forced to solve it.

### 1.4 Why now
The bottleneck was never the pricing engine. It was extracting clean structured data from a messy drawing or email thread. **[Certain]** Multimodal models made that tractable in roughly the last 18 months. Rules-based CPQ never could, because rules require a clean structured catalog the long tail does not have. **[Likely]**

### 1.5 Non-obvious insight the product is built on
**The valuable output is an *answer*, not a quote.** A fast, specific "no — outside our envelope, try X" preserves the relationship and clears the queue. A large share of the 30–40% unanswered are RFQs nobody wanted to formally decline. Competitors all build quote generators. Build an answer engine. **[Guessing — validate in Phase 0]**

---

## 2. Kill criteria (evaluate before writing code)

Fail any one of these and stop or narrow. Written down now so you cannot rationalise past them later.

| # | Test | Threshold | If failed |
|---|---|---|---|
| K1 | Ask 20 target shops: *"show me the RFQs you didn't answer last month."* | ≥8 can produce a real list or credibly estimate one | Problem is not felt. **Kill.** |
| K2 | Ask 3 design partners for 12 months of quote history in week 1 | ≥2 hand it over | No cold start is possible. **Kill.** |
| K3 | In concierge phase, your drafted line price vs what the estimator would have quoted | within ±10% on ≥70% of lines | Pricing signal is not in the history. **Narrow the vertical or kill.** |
| K4 | After 4 weeks live, estimator edit rate on GREEN lines | ≤30% | No trust → no time saved → no product. **Rebuild §5.4 gating.** |

K3 is the one people skip. Run it manually on 100 real lines before you build anything.

---

## 3. Users

| Role | What they own | What they actually want | How they judge the product |
|---|---|---|---|
| **Estimator / inside sales rep** (primary user) | Turning RFQs into quotes | To stop retyping part numbers and to not get blamed for a bad price | "Did it save me time without making me look stupid to a customer?" |
| **Owner / VP Sales** (buyer) | Revenue | More quotes out the door, faster than the competitor | "Did we answer more RFQs and win more?" |
| **Controller / GM** (blocker) | Margin | To never quote a job below cost | "Has it mis-priced anything yet?" |

Design for the estimator; sell to the owner; survive the controller. The controller kills pilots. **[Likely]**

---

## 4. Non-goals

Explicit, because feature creep is the failure mode for this category.

- **No CRM.** No pipeline, no activity tracking, no lead scoring.
- **No customer-facing portal.** Buyers keep using email.
- **No production scheduling, capacity planning, or shop-floor anything.**
- **No 3D CAD geometry cost modelling.** This is the funded incumbent's home turf (Paperless Parts, US CNC job shops). Wedge on messy 2D prints, catalog line items, and fabrication/assembly BOMs instead. **[Likely]**
- **No ERP write-back in V1.** Read-only or file-based export. ERP integration is a 6-week tax per customer and buys nothing at the wedge.
- **No analytics dashboard in V1.** One number in an email digest, not a dashboard.
- **No procurement / vendor sourcing.**
- **No multi-language in V1.**

Shipping rule: if a feature does not reduce time-from-RFQ-to-answer or increase the share of RFQs answered, it does not ship.

---

## 5. Product

Three features. Nothing else exists in V1.

### 5.1 Feature 1 — Ingest

**Input:** one email address. Customer forwards or auto-forwards their `quotes@` / `sales@` inbox, or connects it read-only.

**The system extracts:**
- Sender, account (matched to existing customer history), thread context
- Requested line items: description, quantity, part number if present, material, finish, tolerance, revision
- Quantity breaks requested (e.g. 100 / 500 / 1000)
- Deadline — both the buyer's stated quote-by date and any delivery requirement
- Attachments: native PDFs, scanned raster prints, spreadsheets, photos, DXF/DWG where present

**Hard requirements:**
- Must handle scanned/rotated/skewed raster drawings and read title blocks and revision fields, not just body text. **[Certain — this is the actual moat work]**
- Must resolve "same as PO 4471 but 400 units" against the customer's own quote and order history.
- Must reconcile a line-item table in an email body against a differing table in the attachment, and surface the conflict rather than silently picking one.
- Must extract nothing it cannot cite back to a location in the source document. Every extracted field carries a source pointer (file, page, bbox).

**Output:** a structured RFQ record with a per-field extraction confidence and source pointer.

### 5.2 Feature 2 — Draft the answer

The system produces one of three answer types, chosen automatically and reversible by the user:

**(a) Priced quote.** Line-by-line, each line carrying:
- The resolved item (SKU / historical line / spec)
- Price and the **price basis** — the specific historical quote, vendor price list entry, or cost record it came from, linked and viewable in one click
- Quantity break pricing where requested
- Lead time
- Confidence state (§5.4)

**(b) Priced quote with stated assumptions.** Same as (a), plus an **Assumptions & Exclusions block** generated from every AMBER line. Each assumption is written as a plain sentence the estimator confirms, and it is carried into the outbound quote document so it is contractually visible to the buyer. This is where estimator judgment lives and where mis-quote liability is managed. **[Likely — the single most important design decision in the product]**

**(c) Fast decline with reason.** Triggered when the RFQ falls outside a configured capability envelope (material, size, tolerance class, certification, lead time, minimum order value) or when required clarification is unobtainable before the deadline. Drafts a short, specific, non-generic decline. Optionally suggests a referral.

**Plus, always:** a **clarification draft** for any RED line — a targeted question to the buyer ("Rev C of print 88-2041 does not specify surface finish; confirm 125 Ra or better?"), never a guessed price.

### 5.3 Feature 3 — Approve, send, learn

- Estimator reviews in a single screen: source document on the left, drafted answer on the right, line-level confidence and price basis inline.
- Edits are made in place. **Every edit is captured as a labelled training signal**: which field, old value, new value, and an optional one-tap reason (`wrong part`, `stale price`, `margin too thin`, `wrong quantity break`, `customer-specific pricing`).
- Send from the tool, or copy out. Sending is not the point; capturing the edit is.
- **Outcome loop:** after the quote's decision window, the system asks the estimator one question — won / lost / no decision, and competitor price if known. One tap. This is the dataset nobody else will have. **[Certain — this is the compounding asset]**

### 5.4 Confidence gating (the core of the product)

Never silently interpolate a price. Three states per line:

| State | Conditions | Behaviour |
|---|---|---|
| **GREEN** | Exact or near-exact item resolution, ≥N priced comparables within M months, price variance below threshold, input quality high | Auto-priced with citation. No user action required. |
| **AMBER** | Weak match, thin/stale comparables, high variance, degraded input (scan quality, missing spec), unstated material or finish, quantity outside known breaks | Priced, but an assumption sentence is generated and must be confirmed. Assumption is published in the quote. |
| **RED** | No resolvable item, no comparable price basis, illegible or contradictory input, or capability-envelope violation | **Not priced.** Generates a clarification question or routes to decline. |

**Override rule:** any line whose derived price falls below a customer-configured margin floor is forced to AMBER regardless of match confidence. The controller must be able to see this rule and set the floor. **[Certain — this is what gets the pilot approved]**

**Initial thresholds (replace with measured values):** N = 3 comparables, M = 12 months, variance threshold = 15% coefficient of variation. **[Guessing]**

---

## 6. Data model (minimum viable)

```
customer            id, name, vertical, margin_floor, capability_envelope
rfq                 id, customer_id, account_id, received_at, deadline, channel, raw_refs[]
rfq_line            id, rfq_id, raw_text, qty, qty_breaks[], extracted_fields{}, source_ptr, extract_conf
resolved_item       id, rfq_line_id, sku|spec_hash, match_type, match_score
price_basis         id, resolved_item_id, source_type(historical_quote|vendor_list|cost_record),
                    source_id, unit_price, as_of_date, comparable_count, variance
quote               id, rfq_id, answer_type(priced|priced_with_assumptions|decline|clarify),
                    sent_at, total, margin_pct
quote_line          id, quote_id, resolved_item_id, unit_price, confidence_state, price_basis_id
assumption          id, quote_line_id, text, confirmed_by, confirmed_at
edit_event          id, quote_line_id, field, old_value, new_value, reason_code, user_id, at
outcome             id, quote_id, result(won|lost|no_decision), competitor_price, margin_realized, at
```

`edit_event` and `outcome` are the product. Everything else is plumbing.

---

## 7. Onboarding / cold start

This is a hard gate, not a setup wizard.

**Required from the customer before go-live:**
1. 12–24 months of historical quotes (PDF exports, ERP dump, or email archive — accept all three)
2. Current vendor price lists / cost files
3. Capability envelope, captured in one 30-minute call
4. Margin floor, set by the controller

**Minimum viable corpus:** ~300 historical priced lines and ≥50 distinct resolved items. Below that, GREEN is unreachable and the product is a worse version of the estimator. **[Guessing — measure in Phase 0]**

**Rule: no history, no onboarding.** Turning away a prospect who won't share quote history is cheaper than a failed pilot. **[Certain]**

---

## 8. Success metrics

**North star: RFQ Answer Coverage** — % of inbound RFQs receiving a substantive answer (quote, quote-with-assumptions, or decline) within 24 hours.
Expected baseline 60–70% from the Go Autonomous finding. **[Certain]** Target ≥95%.

**Secondary**
- Median time-to-answer (target: hours, not days)
- Answers sent per estimator per week
- Win rate on RFQs that would previously have gone unanswered — the revenue story
- Share of lines landing GREEN (the automation ceiling)
- Line-level edit rate on GREEN (trust proxy; see K4)

**Guardrail (report weekly, unprompted)**
- Mis-quote rate: lines sent below true cost. Must be ≤ the human baseline you measure in Phase 0. If you don't measure the human baseline first, you cannot defend this number when it happens. **[Certain]**

**Vanity metrics to refuse to report:** documents processed, hours saved, AI accuracy %.

---

## 9. Pricing

**Recommended V1:** monthly platform fee + per-RFQ-answered fee. Charge for answers, not seats — the unit of value is the answer, and it aligns your revenue with the metric you're selling. **[Likely]**

**Rejected:** per-seat (rewards the wrong thing, caps at 2–3 estimators per shop), % of won revenue (attribution fights, unbankable), free tier (this buyer does not self-serve). **[Likely]**

**Anchor the price against the loss, not against software.** One recovered job is the entire annual contract for most shops. Bring their own unanswered-RFQ list to the pricing conversation. **[Likely]**

---

## 10. Rollout

**Phase 0 — Concierge (weeks 0–6). No product.**
You personally answer inbound RFQs for 2–3 shops using nothing but their history and manual work. Objectives: pass K1–K3, measure the human mis-quote baseline, discover the real distribution of input formats, and find out what share of unanswered RFQs should have been declines. Deliverable is a spreadsheet, not code.

**Phase 1 — V1 (weeks 6–16). One vertical only.**
Inbox → extract → draft → approve → send → capture edit. Features 1–3 and nothing in §4. Pick one vertical and refuse the others: metal fabrication, electrical/industrial distribution, or building products. Depth of price resolution in one vertical beats coverage across three. **[Likely]**

**Phase 2 — Outcome loop and margin intelligence.**
Win/loss capture, price-elasticity feedback to the estimator ("this line has won 4/11 at this margin"), auto-tuned confidence thresholds per customer.

**Phase 3 — Cross-customer cost benchmark.**
Aggregate, anonymised cost/price benchmarks per item class. This is the asset no incumbent can assemble and the reason the company is worth more than its ARR. Requires explicit contractual consent from day one — put the data rights clause in the Phase 1 contract, not later. **[Certain]**

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| A wrong price is a job taken at a loss, not a bad paragraph | **Fatal** | RED never prices. Margin floor forces AMBER. Assumptions published in the quote. Confidence gating is the product, not a polish item. |
| No historical quote data | **Fatal** | K2 gate. Refuse onboarding without it. |
| "My pricing is my edge" objection | High | Position as *your* pricing, applied faster — you are not recommending prices, you are retrieving theirs. Cross-customer benchmarking stays out of the V1 pitch entirely. **[Likely]** |
| Paperless Parts / funded incumbents | High | Counterposition explicitly: they price geometry for CNC job shops; you answer messy inbound for fabrication and distribution. If you cannot say this in one sentence to a customer, the idea is dead. **[Certain]** |
| Estimator sees the tool as a threat to their job | Medium | The tool never sends without approval; the estimator's name is on the quote; frame as clearing the backlog they already hate. **[Likely]** |
| Long-tail willingness to pay | Medium | Sell to the $10M–$150M revenue band, not sub-$5M shops. **[Guessing]** |
| ERP integration demands stall pilots | Medium | Non-goal in V1. File export. Say no. |

---

## 12. Open questions to answer with data, not opinion

1. What share of unanswered RFQs *should* have been declines? Changes the product's centre of gravity. (Phase 0)
2. Is the binding constraint extraction accuracy or price resolution? Determines where engineering goes. (Phase 0, K3)
3. What is the true GREEN ceiling — 40% of lines or 85%? Determines whether this is a 3x or 20x speedup, and therefore the price. (Phase 1, week 4)
4. Which vertical has the highest ratio of messy-input pain to price-resolution difficulty?
5. Does the outcome loop actually get filled in, or does one tap turn out to be one tap too many?

---

## 13. What I would cut if forced to ship in 3 weeks

Keep: email ingest, line extraction with source pointers, price basis retrieval from history, RED/AMBER/GREEN gating, one review screen, copy-out.
Cut: decline drafting, clarification drafting, quantity breaks, outcome loop, send-from-tool, margin floor UI (hardcode it per customer).

Do not cut the confidence gating. Without it this is a hallucination machine pointed at someone's margin.
