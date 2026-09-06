import { parseEml } from "./parseEml";
import {
  parseAddress,
  syntheticMessageId,
  type InboundAttachment,
  type InboundEmailPayload,
} from "./types";

/**
 * Normalise an inbound-parse webhook body into `InboundEmailPayload`.
 *
 * Providers disagree on field names but not on substance, so this reads the
 * union rather than committing the repo to one vendor: Postmark
 * (`FromFull`/`TextBody`), SendGrid (`from`/`text`), Resend, Mailgun
 * (`body-plain`/`sender`), and anything that simply posts the raw MIME message
 * under `raw`/`message`/`mime`.
 *
 * Unknown fields are ignored rather than rejected. A shape this parser cannot
 * read at all throws, and the webhook records the failure — an email that
 * silently vanishes is worse than one that errors loudly.
 */
export function normalizeInboundPayload(raw: unknown): InboundEmailPayload {
  if (raw == null || typeof raw !== "object") {
    throw new Error("Inbound payload is not an object");
  }
  const p = raw as Record<string, unknown>;

  // Providers that hand over the raw MIME message: parse it and we are done.
  const rawMime = str(p.raw) ?? str(p.message) ?? str(p.mime) ?? str(p["raw-mime"]);
  if (rawMime && /^[\w-]+:\s/m.test(rawMime) && /\n\s*\n/.test(rawMime)) {
    return parseEml(rawMime);
  }

  const fromRaw =
    fullAddress(p.FromFull) ??
    fullAddress(p.from) ??
    str(p.From) ??
    str(p.from) ??
    str(p.sender) ??
    str(p.envelope_from);
  const from = parseAddress(fromRaw);
  if (!from.email) {
    throw new Error("Inbound payload has no sender address");
  }

  const toRaw =
    fullAddress(p.ToFull) ??
    fullAddress(p.to) ??
    str(p.To) ??
    str(p.to) ??
    str(p.recipient) ??
    str(p.envelope_to);

  const textBody =
    str(p.TextBody) ?? str(p.text) ?? str(p["body-plain"]) ?? str(p.plain) ?? undefined;
  const htmlBody =
    str(p.HtmlBody) ?? str(p.html) ?? str(p["body-html"]) ?? undefined;

  if (textBody == null && htmlBody == null) {
    throw new Error("Inbound payload has no text or html body");
  }

  const receivedAtRaw = str(p.Date) ?? str(p.date) ?? str(p.timestamp) ?? str(p.receivedAt);
  const parsedDate = receivedAtRaw ? new Date(receivedAtRaw) : new Date();
  const receivedAt = Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;

  const subject = str(p.Subject) ?? str(p.subject) ?? undefined;
  const messageId =
    str(p.MessageID) ??
    str(p.MessageId) ??
    str(p.messageId) ??
    str(p["message-id"]) ??
    str(p["Message-Id"]) ??
    headerValue(p.Headers ?? p.headers, "message-id") ??
    syntheticMessageId({
      fromEmail: from.email,
      subject,
      body: textBody ?? htmlBody,
      receivedAt,
    });

  return {
    messageId: messageId.trim(),
    fromEmail: from.email,
    fromName: from.name ?? str(p.FromName) ?? undefined,
    toEmail: parseAddress(toRaw).email || undefined,
    subject,
    textBody,
    htmlBody,
    receivedAt,
    attachments: normalizeAttachments(p.Attachments ?? p.attachments),
  };
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** Postmark-style `{ Email, Name }` / `[{ email, name }]` address objects. */
function fullAddress(v: unknown): string | undefined {
  const one = Array.isArray(v) ? v[0] : v;
  if (one == null || typeof one !== "object") return undefined;
  const o = one as Record<string, unknown>;
  const email = str(o.Email) ?? str(o.email) ?? str(o.address);
  if (!email) return undefined;
  const name = str(o.Name) ?? str(o.name);
  return name ? `${name} <${email}>` : email;
}

function headerValue(headers: unknown, wanted: string): string | undefined {
  if (!Array.isArray(headers)) return undefined;
  for (const h of headers) {
    if (h == null || typeof h !== "object") continue;
    const o = h as Record<string, unknown>;
    const name = str(o.Name) ?? str(o.name) ?? str(o.key);
    if (name?.toLowerCase() === wanted) return str(o.Value) ?? str(o.value);
  }
  return undefined;
}

function normalizeAttachments(v: unknown): InboundAttachment[] {
  if (!Array.isArray(v)) return [];
  const out: InboundAttachment[] = [];
  for (const item of v) {
    if (item == null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const fileName =
      str(o.Name) ?? str(o.name) ?? str(o.filename) ?? str(o.fileName) ?? "attachment";
    const mimeType =
      str(o.ContentType) ?? str(o.contentType) ?? str(o.type) ?? "application/octet-stream";
    const size = typeof o.ContentLength === "number"
      ? o.ContentLength
      : typeof o.size === "number"
        ? o.size
        : undefined;
    out.push({
      fileName,
      mimeType,
      size,
      contentBase64: str(o.Content) ?? str(o.content) ?? undefined,
    });
  }
  return out;
}
