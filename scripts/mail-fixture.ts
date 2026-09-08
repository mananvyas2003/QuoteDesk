/**
 * Feed a local `.eml` through the inbound pipeline, for demoing and debugging
 * the mail path without a provider.
 *
 *   npm run mail:fixture                                   # both bundled fixtures
 *   npm run mail:fixture -- scripts/fixtures/sample-rfq.eml
 *   npm run mail:fixture -- ./some-real-email.eml --webhook http://localhost:3000
 *
 * By default this calls `receiveInboundEmail` directly against DATABASE_URL —
 * the same function the webhook route calls, not a parallel implementation.
 * With `--webhook <baseUrl>` it POSTs to a running server's
 * /api/inbound-email instead, which exercises the HTTP layer and the shared
 * secret too.
 */
// Load .env so DATABASE_URL and the document-extraction key are present when
// this is run directly rather than through Next.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_FIXTURES = [
  "scripts/fixtures/sample-rfq.eml",
  "scripts/fixtures/sample-not-rfq.eml",
  // Carries a PDF whose title block holds the material, finish, tolerance and
  // revision the email body omits. Without a document key configured this one
  // still drafts, reporting the attachment as unread.
  "scripts/fixtures/sample-rfq-with-drawing.eml",
];

async function main() {
  const argv = process.argv.slice(2);
  const webhookIdx = argv.indexOf("--webhook");
  const webhookBase = webhookIdx >= 0 ? argv[webhookIdx + 1] : undefined;
  const paths = argv.filter((a, i) => {
    if (a.startsWith("--")) return false;
    if (webhookIdx >= 0 && i === webhookIdx + 1) return false;
    return true;
  });
  const files = paths.length ? paths : DEFAULT_FIXTURES;

  for (const file of files) {
    const raw = readFileSync(resolve(file), "utf8");
    console.log(`\n=== ${file} ===`);

    if (webhookBase) {
      await viaWebhook(webhookBase, raw);
    } else {
      await direct(raw);
    }
  }

  if (!webhookBase) {
    const { prisma } = await import("../src/lib/db");
    await prisma.$disconnect();
  }
}

async function direct(raw: string) {
  const { parseEml } = await import("../src/lib/email/parseEml");
  const { receiveInboundEmail } = await import("../src/lib/inbound");
  const { getWorkspaceContext } = await import("../src/lib/workspace");

  const payload = parseEml(raw);
  console.log(`From:    ${payload.fromName ?? ""} <${payload.fromEmail}>`);
  console.log(`Subject: ${payload.subject ?? "(none)"}`);
  console.log(`Msg-ID:  ${payload.messageId}`);

  const { workspace } = await getWorkspaceContext();
  const outcome = await receiveInboundEmail(workspace.id, payload);
  report(outcome);
}

async function viaWebhook(base: string, raw: string) {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("INBOUND_WEBHOOK_SECRET must be set to post to the webhook");
  }
  const res = await fetch(`${base.replace(/\/$/, "")}/api/inbound-email`, {
    method: "POST",
    headers: { "Content-Type": "message/rfc822", "X-QuoteDesk-Secret": secret },
    body: raw,
  });
  const json = (await res.json()) as Record<string, unknown>;
  console.log(`HTTP ${res.status}`);
  report(json as never);
}

function report(outcome: {
  kind?: string;
  classification?: { isRfq: boolean; confidence: number; reason: string };
  states?: string[];
  rfqId?: string | null;
  message?: string;
  error?: string;
}) {
  if (outcome.error) {
    console.log(`ERROR:   ${outcome.error}`);
    return;
  }
  console.log(`Outcome: ${outcome.kind}`);
  if (outcome.classification) {
    const c = outcome.classification;
    console.log(
      `Classed: ${c.isRfq ? "RFQ" : "NOT an RFQ"} (confidence ${c.confidence})\n         ${c.reason}`,
    );
  }
  if (outcome.states?.length) {
    const tally = outcome.states.reduce<Record<string, number>>((acc, s) => {
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `Draft:   ${outcome.states.length} lines — ` +
        ["GREEN", "AMBER", "RED"].map((s) => `${tally[s] ?? 0} ${s}`).join(", "),
    );
    console.log(`Review:  /rfqs/${outcome.rfqId}  (nothing sent to the customer)`);
  }
  if (outcome.message) console.log(`Message: ${outcome.message}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
