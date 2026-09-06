import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prisma } from "./db";
import { htmlToText } from "./email/parseEml";
import type { InboundAttachment, InboundEmailPayload } from "./email/types";
import { classifyRfq, type RfqClassification } from "./rfqClassify";
import { ingestRfq } from "./ingest";
import { notifyDraftReady, notifyIngestError } from "./notify";

/**
 * The single entry point for inbound mail — used by the webhook route and by
 * the local fixture runner alike, so a fixture demo is evidence about the real
 * path rather than about a parallel one.
 *
 * Order matters: persist, then deduplicate, then classify, then ingest, then
 * notify. Persisting first means an email that later fails to draft still left
 * a record; deduplicating on the stored Message-ID means a provider retry is a
 * no-op rather than a second RFQ.
 */

export type InboundOutcome =
  | { kind: "duplicate"; inboundEmailId: string; rfqId: string | null }
  | { kind: "skipped_not_rfq"; inboundEmailId: string; classification: RfqClassification }
  | {
      kind: "drafted";
      inboundEmailId: string;
      rfqId: string;
      quoteId: string;
      classification: RfqClassification;
      notificationId: string;
      states: string[];
    }
  | { kind: "error"; inboundEmailId: string; message: string };

export async function receiveInboundEmail(
  workspaceId: string,
  payload: InboundEmailPayload,
  opts?: { allowLlm?: boolean; storageDir?: string },
): Promise<InboundOutcome> {
  // 1. Deduplicate. Providers retry deliveries; a retry must not re-ingest.
  const existing = await prisma.inboundEmail.findUnique({
    where: { messageId: payload.messageId },
  });
  if (existing) {
    return { kind: "duplicate", inboundEmailId: existing.id, rfqId: existing.rfqId };
  }

  // 2. Persist before deciding anything, so nothing arrives and vanishes.
  const stored = await storeAttachments(payload, opts?.storageDir);
  let record;
  try {
    record = await prisma.inboundEmail.create({
      data: {
        workspaceId,
        messageId: payload.messageId,
        fromEmail: payload.fromEmail,
        fromName: payload.fromName ?? null,
        toEmail: payload.toEmail ?? null,
        subject: payload.subject ?? null,
        textBody: payload.textBody ?? null,
        htmlBody: payload.htmlBody ?? null,
        receivedAt: payload.receivedAt,
        attachments: JSON.stringify(stored),
        status: "received",
      },
    });
  } catch (err) {
    // A unique-constraint race: two concurrent deliveries of the same message.
    const again = await prisma.inboundEmail.findUnique({
      where: { messageId: payload.messageId },
    });
    if (again) return { kind: "duplicate", inboundEmailId: again.id, rfqId: again.rfqId };
    throw err;
  }

  const bodyText = plainTextBody(payload);

  // 3. Classify.
  const classification = await classifyRfq(
    {
      subject: payload.subject,
      body: bodyText,
      attachmentNames: stored.map((a) => a.fileName),
      fromEmail: payload.fromEmail,
    },
    { allowLlm: opts?.allowLlm },
  );

  if (!classification.isRfq) {
    await prisma.inboundEmail.update({
      where: { id: record.id },
      data: {
        status: "skipped_not_rfq",
        classification: JSON.stringify(classification),
      },
    });
    return { kind: "skipped_not_rfq", inboundEmailId: record.id, classification };
  }

  await prisma.inboundEmail.update({
    where: { id: record.id },
    data: {
      status: "classified_rfq",
      classification: JSON.stringify(classification),
    },
  });

  // 4. Hand to the existing pipeline. No pricing logic lives here.
  try {
    const { rfq, quote } = await ingestRfq({
      workspaceId,
      subject: payload.subject,
      fromEmail: payload.fromEmail,
      fromName: payload.fromName,
      body: bodyText,
      channel: "email",
      fileName: stored[0]?.fileName ?? "email.txt",
    });

    const states = quote.lines.map((l) => l.confidenceState);

    // 5. Notify the estimator. Never the buyer.
    const { notificationId } = await notifyDraftReady({
      workspaceId,
      rfqId: rfq.id,
      subject: payload.subject ?? null,
      fromEmail: payload.fromEmail,
      states,
    });

    await prisma.inboundEmail.update({
      where: { id: record.id },
      data: { status: "drafted", rfqId: rfq.id },
    });

    return {
      kind: "drafted",
      inboundEmailId: record.id,
      rfqId: rfq.id,
      quoteId: quote.id,
      classification,
      notificationId,
      states,
    };
  } catch (err) {
    const message = (err as Error).message;
    await prisma.inboundEmail.update({
      where: { id: record.id },
      data: { status: "error", error: message },
    });
    await notifyIngestError({
      workspaceId,
      subject: payload.subject ?? null,
      fromEmail: payload.fromEmail,
      message,
    });
    return { kind: "error", inboundEmailId: record.id, message };
  }
}

/**
 * The text the extractor and classifier see. Prefer the plain-text part; fall
 * back to a flattened HTML body, since plenty of buyers send HTML-only mail.
 */
export function plainTextBody(payload: InboundEmailPayload): string {
  const text = (payload.textBody ?? "").trim();
  if (text) return text;
  const html = (payload.htmlBody ?? "").trim();
  return html ? htmlToText(html) : "";
}

/**
 * Write attachment bytes to local storage and return metadata.
 *
 * Metadata only reaches the database; bytes go to disk. Nothing reads them —
 * there is no OCR in this build, and a scanned print with no extractable lines
 * correctly produces a RED line asking the buyer for specs.
 */
async function storeAttachments(
  payload: InboundEmailPayload,
  storageDir?: string,
): Promise<InboundAttachment[]> {
  const out: InboundAttachment[] = [];
  const baseDir = storageDir ?? process.env.INBOUND_STORAGE_DIR ?? "storage/inbound";

  for (const [i, a] of payload.attachments.entries()) {
    const meta: InboundAttachment = {
      fileName: a.fileName,
      mimeType: a.mimeType,
      size: a.size,
    };

    if (a.contentBase64) {
      try {
        const dir = resolve(baseDir, safeSegment(payload.messageId));
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${i}-${safeSegment(a.fileName)}`);
        const bytes = Buffer.from(a.contentBase64, "base64");
        writeFileSync(path, bytes);
        meta.storagePath = path;
        meta.size = bytes.length;
      } catch (err) {
        // Storage failure must not lose the email; record the gap instead.
        meta.storagePath = undefined;
        meta.fileName = `${a.fileName} (not stored: ${(err as Error).message})`;
      }
    }
    out.push(meta);
  }
  return out;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "file";
}
