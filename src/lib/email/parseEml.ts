import {
  parseAddress,
  syntheticMessageId,
  type InboundAttachment,
  type InboundEmailPayload,
} from "./types";

/**
 * A deliberately small RFC 5322 / MIME reader — enough for `.eml` fixtures and
 * for providers that hand over the raw message instead of parsed fields.
 *
 * It handles what real fabrication-shop mail actually arrives as: folded
 * headers, quoted-printable and base64 transfer encodings, and multipart bodies
 * with attachments. It does not attempt nested multipart trees beyond one level
 * of recursion, and it does not decode attachment content beyond recording it —
 * attachment bytes are stored and read later by src/lib/documents, not here.
 */
export function parseEml(raw: string): InboundEmailPayload {
  const { headers, body } = splitHeaders(raw);

  const contentType = headers["content-type"] ?? "text/plain";
  const boundary = contentType.match(/boundary\s*=\s*"?([^";\s]+)"?/i)?.[1];

  let textBody: string | undefined;
  let htmlBody: string | undefined;
  const attachments: InboundAttachment[] = [];

  if (boundary) {
    collectParts(body, boundary, (part) => {
      const partType = (part.headers["content-type"] ?? "text/plain").toLowerCase();
      const disposition = part.headers["content-disposition"] ?? "";
      const fileName =
        disposition.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1] ??
        partType.match(/name\s*=\s*"?([^";]+)"?/i)?.[1];

      if (/attachment/i.test(disposition) || fileName) {
        attachments.push({
          fileName: (fileName ?? "attachment").trim(),
          mimeType: partType.split(";")[0].trim(),
          size: part.decoded.length,
          contentBase64: Buffer.from(part.decoded, "binary").toString("base64"),
        });
        return;
      }
      if (partType.startsWith("text/plain") && textBody == null) textBody = part.decoded;
      else if (partType.startsWith("text/html") && htmlBody == null) htmlBody = part.decoded;
    });
  } else {
    const decoded = decodeBody(body, headers["content-transfer-encoding"]);
    if (contentType.toLowerCase().startsWith("text/html")) htmlBody = decoded;
    else textBody = decoded;
  }

  const from = parseAddress(headers.from);
  const receivedAt = headers.date ? new Date(headers.date) : new Date();

  return {
    messageId:
      headers["message-id"]?.trim() ||
      syntheticMessageId({
        fromEmail: from.email,
        subject: headers.subject,
        body: textBody ?? htmlBody,
        receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
      }),
    fromEmail: from.email,
    fromName: from.name,
    toEmail: parseAddress(headers.to).email || undefined,
    subject: headers.subject ? decodeHeaderWord(headers.subject) : undefined,
    textBody,
    htmlBody,
    receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
    attachments,
  };
}

function splitHeaders(raw: string): {
  headers: Record<string, string>;
  body: string;
} {
  const normalised = raw.replace(/\r\n/g, "\n");
  const blank = normalised.indexOf("\n\n");
  const headerText = blank === -1 ? normalised : normalised.slice(0, blank);
  const body = blank === -1 ? "" : normalised.slice(blank + 2);

  // Unfold continuation lines before splitting on ':'.
  const unfolded = headerText.replace(/\n[ \t]+/g, " ");
  const headers: Record<string, string> = {};
  for (const line of unfolded.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    // First occurrence wins; trace headers repeat and the earliest is the one
    // the sender set.
    if (!(key in headers)) headers[key] = line.slice(idx + 1).trim();
  }
  return { headers, body };
}

function collectParts(
  body: string,
  boundary: string,
  visit: (part: { headers: Record<string, string>; decoded: string }) => void,
  depth = 0,
): void {
  if (depth > 3) return;
  const marker = `--${boundary}`;
  const segments = body.split(marker).slice(1);

  for (const segment of segments) {
    if (segment.startsWith("--")) break; // closing boundary
    const { headers, body: partBody } = splitHeaders(segment.replace(/^\n/, ""));
    const partType = headers["content-type"] ?? "text/plain";
    const nested = partType.match(/boundary\s*=\s*"?([^";\s]+)"?/i)?.[1];
    if (nested) {
      collectParts(partBody, nested, visit, depth + 1);
      continue;
    }
    visit({ headers, decoded: decodeBody(partBody, headers["content-transfer-encoding"]) });
  }
}

function decodeBody(body: string, encoding: string | undefined): string {
  const enc = (encoding ?? "7bit").trim().toLowerCase();
  const trimmed = body.replace(/\n+$/, "");
  if (enc === "base64") {
    return Buffer.from(trimmed.replace(/\s+/g, ""), "base64").toString("utf8");
  }
  if (enc === "quoted-printable") return decodeQuotedPrintable(trimmed);
  return trimmed;
}

function decodeQuotedPrintable(input: string): string {
  const joined = input.replace(/=\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** RFC 2047 encoded-word, the form subjects with non-ASCII arrive in. */
function decodeHeaderWord(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_all, _charset: string, kind: string, text: string) => {
      if (kind.toLowerCase() === "b") {
        return Buffer.from(text, "base64").toString("utf8");
      }
      return decodeQuotedPrintable(text.replace(/_/g, " "));
    },
  );
}

/** Best-effort plain text from an HTML-only email, for classification. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<\/td>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
