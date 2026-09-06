import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDb, monthsAgo } from "./helpers/db";
import { parseEml } from "../src/lib/email/parseEml";
import { normalizeInboundPayload } from "../src/lib/email/normalize";
import { receiveInboundEmail } from "../src/lib/inbound";
import { assertNotBuyerAddress, BuyerAddressError } from "../src/lib/notify";
import type { InboundEmailPayload } from "../src/lib/email/types";

/**
 * Inbound-mail pipeline guards: receive -> classify -> ingest -> notify.
 *
 * Nothing here asserts a price. Pricing is covered by the existing suite and
 * unchanged by this feature; these tests cover the mail path around it.
 */

const ENVELOPE = JSON.stringify({
  materials: ["A36", "A572", "SS304"],
  toleranceClasses: ["±1/16", "ISO 2768-m"],
});

let workspaceId: string;
let storageDir: string;

before(async () => {
  const prisma = await testDb();
  storageDir = mkdtempSync(join(tmpdir(), "quotedesk-inbound-"));

  const ws = await prisma.workspace.create({
    data: {
      name: "Mail Test Shop",
      capabilityEnvelope: ENVELOPE,
      onboardedAt: new Date(),
    },
  });
  await prisma.user.create({
    data: {
      workspaceId: ws.id,
      email: "estimator@mailtest.example",
      name: "Mail Estimator",
      role: "estimator",
    },
  });
  const account = await prisma.account.create({
    data: { workspaceId: ws.id, name: "Acme Industrial", domain: "acmeindustrial.example" },
  });

  // A small corpus so drafting has something to resolve against.
  for (const [i, row] of [
    { qty: 100, unitPrice: 12.75 },
    { qty: 150, unitPrice: 12.1 },
    { qty: 200, unitPrice: 11.4 },
    { qty: 250, unitPrice: 11.2 },
  ].entries()) {
    await prisma.historicalQuote.create({
      data: {
        workspaceId: ws.id,
        accountId: account.id,
        quoteNumber: `MQ-${i}`,
        quotedAt: monthsAgo(i + 1),
        lines: {
          create: [
            {
              description: "Guard bracket laser cut",
              partNumber: "GB-88",
              material: "A36",
              finish: "powder coat black",
              sku: "FAB-GB-88",
              qty: row.qty,
              unitPrice: row.unitPrice,
            },
          ],
        },
      },
    });
  }

  workspaceId = ws.id;
});

function payloadFromFixture(file: string): InboundEmailPayload {
  return parseEml(readFileSync(file, "utf8"));
}

test("a .eml fixture parses into headers, decoded body and a Message-ID", () => {
  const p = payloadFromFixture("scripts/fixtures/sample-rfq.eml");

  assert.equal(p.fromEmail, "dana.whitfield@acmeindustrial.example");
  assert.equal(p.fromName, "Dana Whitfield");
  assert.equal(p.toEmail, "quotes@summitmetalfab.example");
  assert.equal(p.messageId, "<rfq-8812-acme@acmeindustrial.example>");
  assert.match(p.subject!, /RFQ 8812/);
  // quoted-printable must be decoded, or the extractor sees "=C2=B11/16".
  assert.match(p.textBody!, /±1\/16/);
  assert.match(p.textBody!, /—/, "encoded em dash must decode");
  assert.match(p.textBody!, /GB-88 \| Guard bracket laser cut \| 200 \| A36/);
});

test("an RFQ email creates an RFQ, a drafted quote and a notification", async () => {
  const prisma = await testDb();
  const outcome = await receiveInboundEmail(
    workspaceId,
    payloadFromFixture("scripts/fixtures/sample-rfq.eml"),
    { allowLlm: false, storageDir },
  );

  assert.equal(outcome.kind, "drafted", JSON.stringify(outcome));
  if (outcome.kind !== "drafted") return;

  assert.equal(outcome.classification.isRfq, true);
  assert.ok(outcome.states.length > 0, "the drafted quote must have lines");

  const rfq = await prisma.rfq.findUniqueOrThrow({
    where: { id: outcome.rfqId },
    include: { quote: { include: { lines: true } } },
  });
  assert.equal(rfq.channel, "email", "an emailed RFQ must record its channel");
  assert.equal(rfq.status, "drafted");
  assert.ok(rfq.quote, "the existing draft engine must have run");
  assert.equal(rfq.quote!.sentAt, null, "nothing may be sent without estimator action");

  // Every line carries a confidence state the review screen can render.
  for (const line of rfq.quote!.lines) {
    assert.ok(["GREEN", "AMBER", "RED"].includes(line.confidenceState));
  }

  const inbound = await prisma.inboundEmail.findUniqueOrThrow({
    where: { id: outcome.inboundEmailId },
  });
  assert.equal(inbound.status, "drafted");
  assert.equal(inbound.rfqId, outcome.rfqId, "the RFQ must link back to the email");

  const notification = await prisma.notification.findUniqueOrThrow({
    where: { id: outcome.notificationId },
  });
  assert.equal(notification.kind, "draft_ready");
  assert.equal(notification.linkPath, `/rfqs/${outcome.rfqId}`, "must link to the review screen");
  assert.match(notification.body!, /Nothing has been sent to the customer/);
});

test("a duplicate Message-ID does not double-ingest", async () => {
  const prisma = await testDb();
  const payload = payloadFromFixture("scripts/fixtures/sample-rfq.eml");

  const before = await prisma.rfq.count({ where: { workspaceId } });
  const again = await receiveInboundEmail(workspaceId, payload, {
    allowLlm: false,
    storageDir,
  });
  const after = await prisma.rfq.count({ where: { workspaceId } });

  assert.equal(again.kind, "duplicate", "a provider retry must be a no-op");
  assert.equal(after, before, "no second RFQ may be created");
  assert.equal(
    await prisma.inboundEmail.count({ where: { messageId: payload.messageId } }),
    1,
  );
});

test("a non-RFQ email is recorded and skipped, and creates no quote", async () => {
  const prisma = await testDb();
  const quotesBefore = await prisma.quote.count();
  const rfqsBefore = await prisma.rfq.count({ where: { workspaceId } });

  const outcome = await receiveInboundEmail(
    workspaceId,
    payloadFromFixture("scripts/fixtures/sample-not-rfq.eml"),
    { allowLlm: false, storageDir },
  );

  assert.equal(outcome.kind, "skipped_not_rfq");
  if (outcome.kind !== "skipped_not_rfq") return;
  assert.equal(outcome.classification.isRfq, false);

  assert.equal(await prisma.quote.count(), quotesBefore, "no priced quote may be created");
  assert.equal(await prisma.rfq.count({ where: { workspaceId } }), rfqsBefore);

  // Skipped, but not lost: the record and the reason survive for review.
  const inbound = await prisma.inboundEmail.findUniqueOrThrow({
    where: { id: outcome.inboundEmailId },
  });
  assert.equal(inbound.status, "skipped_not_rfq");
  assert.ok(inbound.classification, "the skip reason must be recorded");
  assert.equal(inbound.rfqId, null);
});

test("provider webhook payloads normalise to the same shape as a raw .eml", () => {
  // Postmark-style
  const postmark = normalizeInboundPayload({
    FromFull: { Email: "buyer@acmeindustrial.example", Name: "Dana Whitfield" },
    ToFull: [{ Email: "quotes@summitmetalfab.example" }],
    Subject: "RFQ 9001",
    TextBody: "Please quote 100 GB-88.",
    MessageID: "<pm-9001@acmeindustrial.example>",
    Date: "Mon, 8 Sep 2026 09:14:22 -0500",
    Attachments: [{ Name: "print.pdf", ContentType: "application/pdf", ContentLength: 1024 }],
  });
  assert.equal(postmark.fromEmail, "buyer@acmeindustrial.example");
  assert.equal(postmark.fromName, "Dana Whitfield");
  assert.equal(postmark.messageId, "<pm-9001@acmeindustrial.example>");
  assert.equal(postmark.attachments[0].fileName, "print.pdf");

  // SendGrid / Mailgun-style flat fields
  const sendgrid = normalizeInboundPayload({
    from: "Dana <buyer@acmeindustrial.example>",
    to: "quotes@summitmetalfab.example",
    subject: "RFQ 9002",
    text: "Please quote 100 GB-88.",
    headers: [{ name: "Message-Id", value: "<sg-9002@acme.example>" }],
  });
  assert.equal(sendgrid.fromEmail, "buyer@acmeindustrial.example");
  assert.equal(sendgrid.messageId, "<sg-9002@acme.example>");

  // Raw MIME under `raw`
  const raw = normalizeInboundPayload({
    raw: readFileSync("scripts/fixtures/sample-rfq.eml", "utf8"),
  });
  assert.equal(raw.messageId, "<rfq-8812-acme@acmeindustrial.example>");
  assert.equal(raw.fromEmail, "dana.whitfield@acmeindustrial.example");
});

test("mail with no Message-ID gets a stable synthetic one, so retries still dedupe", () => {
  const body = { from: "buyer@acme.example", subject: "RFQ", text: "Please quote 10 widgets." };
  const a = normalizeInboundPayload(body);
  const b = normalizeInboundPayload(body);
  assert.equal(a.messageId, b.messageId, "the same email must produce the same key");
  assert.match(a.messageId, /^<synthetic-/);

  const different = normalizeInboundPayload({ ...body, text: "Please quote 20 widgets." });
  assert.notEqual(a.messageId, different.messageId);
});

test("an unreadable payload throws rather than silently dropping the email", () => {
  assert.throws(() => normalizeInboundPayload(null), /not an object/);
  assert.throws(() => normalizeInboundPayload({ subject: "hi" }), /no sender address/);
  assert.throws(
    () => normalizeInboundPayload({ from: "a@b.example", subject: "hi" }),
    /no text or html body/,
  );
});

test("a notification is never addressed to the buyer", () => {
  // The structural guard behind "no path sends a quote to the customer".
  assert.throws(
    () => assertNotBuyerAddress("buyer@acmeindustrial.example", "buyer@acmeindustrial.example"),
    BuyerAddressError,
  );
  assert.throws(
    () => assertNotBuyerAddress("Buyer@AcmeIndustrial.example ", "buyer@acmeindustrial.example"),
    BuyerAddressError,
    "the check must be case- and whitespace-insensitive",
  );
  // The estimator's own address is fine.
  assert.doesNotThrow(() =>
    assertNotBuyerAddress("estimator@summitmetalfab.example", "buyer@acmeindustrial.example"),
  );
});

test("an HTML-only email is still readable by the extractor", async () => {
  const outcome = await receiveInboundEmail(
    workspaceId,
    {
      messageId: "<html-only-1@acme.example>",
      fromEmail: "buyer@acmeindustrial.example",
      fromName: "Dana",
      subject: "RFQ - brackets",
      htmlBody:
        "<html><body><p>Please quote the following.</p>" +
        "<p>Finish: powder coat black<br>Tolerance: &plusmn;1/16<br>Rev C</p>" +
        "<table><tr><td>GB-88</td><td>Guard bracket laser cut</td><td>200</td><td>A36</td></tr></table>" +
        "</body></html>",
      receivedAt: new Date(),
      attachments: [],
    },
    { allowLlm: false, storageDir },
  );

  assert.equal(outcome.kind, "drafted", JSON.stringify(outcome));
});
