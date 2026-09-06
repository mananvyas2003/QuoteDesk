import { readFileSync, statSync } from "node:fs";
import type { InboundAttachment } from "../email/types";
import type { DocumentKind, ExtractableDocument } from "./types";

/**
 * Caps, not preferences. An inbound webhook is an untrusted entry point: a
 * sender who attaches forty 200MB files must cost us a bounded amount of work.
 */
export const DOCUMENT_LIMITS = {
  /** Documents read per RFQ. Later attachments are recorded but not opened. */
  maxDocuments: 5,
  /** Per document. Roughly the API's own ceiling for an inline document. */
  maxBytes: 8 * 1024 * 1024,
} as const;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * CAD and drawing-exchange formats a shop routinely attaches. They are listed
 * so they can be reported as *recognised but unreadable* rather than silently
 * ignored — an estimator seeing "STEP file not read" knows to open it, whereas
 * silence looks like the file was understood.
 */
const KNOWN_UNREADABLE = /\.(dwg|dxf|step|stp|igs|iges|sldprt|sldasm|x_t|3dm)$/i;

export type DocumentSelection = {
  documents: ExtractableDocument[];
  /** fileName → why it was not opened. Surfaced to the estimator, never dropped. */
  skipped: Array<{ fileName: string; reason: string }>;
};

/**
 * Decide which attachments are worth opening, and read their bytes.
 *
 * Attachment bytes live on disk (`storagePath`); only metadata is in the
 * database. Reading here rather than in the extractor keeps every size and
 * count decision in one auditable place.
 */
export function selectExtractable(
  attachments: InboundAttachment[] | undefined,
  opts?: { maxDocuments?: number; maxBytes?: number },
): DocumentSelection {
  const maxDocuments =
    opts?.maxDocuments ?? envInt("DOCUMENT_MAX_COUNT") ?? DOCUMENT_LIMITS.maxDocuments;
  const maxBytes =
    opts?.maxBytes ?? envInt("DOCUMENT_MAX_BYTES") ?? DOCUMENT_LIMITS.maxBytes;

  const documents: ExtractableDocument[] = [];
  const skipped: DocumentSelection["skipped"] = [];

  for (const a of attachments ?? []) {
    if (documents.length >= maxDocuments) {
      skipped.push({
        fileName: a.fileName,
        reason: `only the first ${maxDocuments} documents are read`,
      });
      continue;
    }

    const kind = classify(a);
    if (!kind) {
      skipped.push({
        fileName: a.fileName,
        reason: KNOWN_UNREADABLE.test(a.fileName)
          ? "CAD geometry is not read in this build"
          : "unsupported file type",
      });
      continue;
    }

    let contentBase64: string | undefined;
    let size = a.size ?? 0;

    if (a.contentBase64) {
      contentBase64 = a.contentBase64;
      size = Buffer.byteLength(a.contentBase64, "base64");
    } else if (a.storagePath) {
      try {
        const stat = statSync(a.storagePath);
        size = stat.size;
        // Check before reading, so an oversized file is never loaded at all.
        if (size > maxBytes) {
          skipped.push({
            fileName: a.fileName,
            reason: `${(size / 1_048_576).toFixed(1)}MB exceeds the ${(
              maxBytes / 1_048_576
            ).toFixed(0)}MB limit`,
          });
          continue;
        }
        contentBase64 = readFileSync(a.storagePath).toString("base64");
      } catch (err) {
        skipped.push({
          fileName: a.fileName,
          reason: `could not be read from storage: ${(err as Error).message}`,
        });
        continue;
      }
    }

    if (!contentBase64) {
      skipped.push({ fileName: a.fileName, reason: "no content was delivered" });
      continue;
    }
    if (size > maxBytes) {
      skipped.push({
        fileName: a.fileName,
        reason: `${(size / 1_048_576).toFixed(1)}MB exceeds the ${(
          maxBytes / 1_048_576
        ).toFixed(0)}MB limit`,
      });
      continue;
    }

    documents.push({
      fileName: a.fileName,
      mimeType: kind === "pdf" ? "application/pdf" : mediaType(a),
      kind,
      contentBase64,
      size,
    });
  }

  return { documents, skipped };
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function extension(fileName: string): string {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

/**
 * Extension and declared MIME type both count, and either is enough. Providers
 * disagree: some send `application/octet-stream` for a PDF, some send a correct
 * type with a mangled filename.
 */
function classify(a: InboundAttachment): DocumentKind | undefined {
  const ext = extension(a.fileName);
  const mime = (a.mimeType ?? "").toLowerCase();

  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (ext in IMAGE_TYPES) return "image";
  if (mime.startsWith("image/") && Object.values(IMAGE_TYPES).includes(mime)) {
    return "image";
  }
  return undefined;
}

function mediaType(a: InboundAttachment): string {
  const ext = extension(a.fileName);
  if (ext in IMAGE_TYPES) return IMAGE_TYPES[ext];
  const mime = (a.mimeType ?? "").toLowerCase();
  return Object.values(IMAGE_TYPES).includes(mime) ? mime : "image/png";
}
