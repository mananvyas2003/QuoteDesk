import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRfqByRules, classifyRfq, isBorderline } from "../src/lib/rfqClassify";

/**
 * Classifier guards.
 *
 * The asymmetry is the point: a missed RFQ costs the shop a job invisibly
 * (PRD §1.3), a false positive costs an estimator a few seconds. These tests
 * pin that bias so a later "accuracy" tidy-up cannot quietly reverse it.
 */

const RFQ_FIXTURES: Array<{ name: string; subject: string; body: string }> = [
  {
    name: "explicit RFQ with a line table",
    subject: "RFQ 8812 - guard brackets",
    body: `Please quote the following.

Part | Description | Qty | Material
GB-88 | Guard bracket laser cut | 200 | A36`,
  },
  {
    name: "prose ask, no part numbers",
    subject: "Pricing needed",
    body: "Morning — we need a quote for 40 stainless shaft collars, 2 inch. Lead time?",
  },
  {
    name: "same as prior PO",
    subject: "Repeat order",
    body: "Same as PO 4471 but 400 units this time. Same print, Rev D.",
  },
  {
    name: "quantity breaks, terse",
    subject: "AC-33",
    body: "Can you price AC-33 angle clip at 100/500/1000? A36, mill finish.",
  },
  {
    name: "scanned print, no specs in body",
    subject: "Print attached",
    body: "See attached scan — please quote off the print. Hard to read, sorry.",
  },
  {
    name: "no explicit ask, but dense quoting signals",
    subject: "22-118 packet",
    body: `Qty 250 each
P/N BP-1218, A36, Rev C
Lead time and delivery date needed for the drawing attached.`,
  },
];

const NOT_RFQ_FIXTURES: Array<{ name: string; subject: string; body: string; from?: string }> = [
  {
    name: "marketing blast",
    subject: "Webinar: 5 ways to cut shop floor downtime",
    body: "Register now for our free webinar. Limited time offer.\n\nUnsubscribe | View in browser",
    from: "no-reply@toolvendor.example",
  },
  {
    name: "out of office",
    subject: "Automatic reply: Out of office",
    body: "I am out of office until 15 December with limited access to email.",
  },
  {
    name: "bounce",
    subject: "Undeliverable: Your message",
    body: "Delivery Status Notification (Failure). Mail delivery failed for the following recipient.",
    from: "mailer-daemon@mail.example",
  },
  {
    name: "accounts payable chase",
    subject: "Statement of account - past due",
    body: "Please find attached your statement of account. Remittance advice appreciated.",
  },
  {
    name: "supplier pitch",
    subject: "Introduction - we supply laser consumables",
    body: "We supply nozzles and lenses. Our catalogue is attached. Become a supplier of choice.",
  },
  {
    name: "empty email",
    subject: "",
    body: "",
  },
];

test("RFQ fixtures are classified as RFQs", () => {
  for (const f of RFQ_FIXTURES) {
    const c = classifyRfqByRules({ subject: f.subject, body: f.body });
    assert.equal(c.isRfq, true, `"${f.name}" should be an RFQ — got: ${c.reason}`);
  }
});

test("non-RFQ fixtures are not classified as RFQs", () => {
  for (const f of NOT_RFQ_FIXTURES) {
    const c = classifyRfqByRules({
      subject: f.subject,
      body: f.body,
      fromEmail: f.from,
    });
    assert.equal(c.isRfq, false, `"${f.name}" should not be an RFQ — got: ${c.reason}`);
  }
});

test("every verdict carries a reason and the signals that produced it", () => {
  const c = classifyRfqByRules({
    subject: "RFQ 8812",
    body: "Please quote 100 GB-88 brackets, A36.",
  });
  assert.ok(c.reason.length > 10, "a bare verdict is not reviewable");
  assert.ok(c.signals.length > 0, "the firing rules must be recorded for audit");
  assert.ok(c.confidence > 0 && c.confidence < 1);
  assert.equal(c.classifier, "rules");
});

test("the bias is toward review, not silent drop", () => {
  // Weak but non-zero quoting signal, no explicit ask, nothing against it.
  const c = classifyRfqByRules({
    subject: "Part BP-1218",
    body: "Do you work with A36?",
  });
  assert.equal(c.isRfq, true, "an ambiguous email must reach a human, not be dropped");
  assert.ok(c.confidence < 0.6, "...but it must not claim to be sure");
  assert.match(c.reason, /ambiguous|dropped|review/i);
});

test("a purchase order that also asks for a price is still an RFQ", () => {
  // The negative signal must not be able to overrule an explicit ask.
  const c = classifyRfqByRules({
    subject: "PO confirmation 5521 + one addition",
    body: "Purchase order attached, order acknowledgement below. Also please quote 50 of BP-1218.",
  });
  assert.equal(c.isRfq, true);
});

test("rules-only works with no API key configured", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const c = await classifyRfq({
      subject: "RFQ 8812",
      body: "Please quote 100 GB-88 brackets.",
    });
    assert.equal(c.isRfq, true);
    assert.equal(c.classifier, "rules", "no key means no LLM call, and no failure");
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("the LLM is never consulted for confident verdicts", () => {
  const confidentRfq = classifyRfqByRules({
    subject: "RFQ 8812 - please quote",
    body: `Please quote the following, Rev C, A36.

Part | Description | Qty | Material
GB-88 | Guard bracket | 200 | A36`,
  });
  assert.equal(isBorderline(confidentRfq), false, "a clear RFQ must not cost an API call");

  const confidentBounce = classifyRfqByRules({
    subject: "Undeliverable",
    body: "Delivery Status Notification (Failure).",
    fromEmail: "mailer-daemon@mail.example",
  });
  assert.equal(isBorderline(confidentBounce), false);
});

test("an explicitly disabled LLM stays disabled even with a key set", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key-for-tests";
  try {
    const c = await classifyRfq(
      { subject: "Part BP-1218", body: "Do you work with A36?" },
      { allowLlm: false },
    );
    assert.equal(c.classifier, "rules", "allowLlm:false must make no network call");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});
