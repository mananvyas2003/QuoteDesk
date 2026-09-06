import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { normalizeInboundPayload } from "@/lib/email/normalize";
import { receiveInboundEmail } from "@/lib/inbound";
import { getWorkspaceContext } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Inbound-parse webhook (PRD §5.1: "Input: one email address").
 *
 * Point a provider's inbound parse at POST /api/inbound-email — Postmark,
 * SendGrid, Resend and Mailgun payload shapes are all accepted, as is a raw MIME
 * message. Configure the shared secret in INBOUND_WEBHOOK_SECRET and send it as
 * `X-QuoteDesk-Secret` or `?secret=`.
 *
 * This handler never sends anything to the buyer. It ingests, drafts, and
 * notifies the estimator; the quote leaves the building only when a human acts
 * on the review screen.
 */
export async function POST(request: Request) {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) {
    // Refuse rather than accept unauthenticated mail into the pipeline.
    return NextResponse.json(
      {
        error:
          "INBOUND_WEBHOOK_SECRET is not set. Configure it before pointing a provider at this endpoint.",
      },
      { status: 503 },
    );
  }

  const provided =
    request.headers.get("x-quotedesk-secret") ??
    new URL(request.url).searchParams.get("secret") ??
    "";
  if (!secretsMatch(provided, secret)) {
    return NextResponse.json({ error: "Invalid webhook secret" }, { status: 401 });
  }

  let payload;
  try {
    const body = await readBody(request);
    payload = normalizeInboundPayload(body);
  } catch (err) {
    // 400, not 500: the provider should not retry a payload we cannot read.
    return NextResponse.json(
      { error: `Unreadable inbound payload: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  try {
    const { workspace } = await getWorkspaceContext();
    const outcome = await receiveInboundEmail(workspace.id, payload);

    // Always 200 on a handled email, including "not an RFQ" and "duplicate" —
    // a non-2xx makes providers retry, and neither case is retryable.
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/** Accepts JSON, form-encoded (SendGrid/Mailgun), or a raw MIME body. */
async function readBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return request.json();
  }
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await request.formData();
    const obj: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") obj[key] = value;
    }
    return obj;
  }

  const text = await request.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
