import type { InboundAttachment } from "../email/types";
import { selectExtractable, type DocumentSelection } from "./attachments";
import type { DocumentExtraction, ExtractableDocument } from "./types";

export { DOCUMENT_LIMITS, selectExtractable } from "./attachments";
export { applyDocumentExtractions, EXTRACTION_CONFIDENCE } from "./merge";
export type {
  DocumentCitation,
  DocumentExtraction,
  DocumentKind,
  DocumentLine,
  ExtractableDocument,
} from "./types";

/**
 * Injectable so the whole pipeline is testable without an API key, and so the
 * multimodal path can be swapped without touching the merge logic.
 */
export type DocumentExtractor = (
  doc: ExtractableDocument,
) => Promise<DocumentExtraction | null>;

export type ExtractDocumentsResult = {
  extractions: DocumentExtraction[];
  /** Attachments that were recorded but not opened, and why. */
  skipped: DocumentSelection["skipped"];
};

/**
 * Open whichever attachments are readable and return what they contain.
 *
 * Reading a drawing is an *enhancement*, exactly as the RFQ classifier's LLM
 * second opinion is. With no key, no package, a timeout or a malformed reply,
 * this returns no extractions and the RFQ is drafted from the email body alone
 * — which is precisely today's behaviour. An outage must degrade the draft, not
 * lose the mail.
 */
export async function extractDocuments(
  attachments: InboundAttachment[] | undefined,
  opts?: {
    extractor?: DocumentExtractor;
    /** Defaults to true; the multimodal call still needs ANTHROPIC_API_KEY. */
    allowLlm?: boolean;
    maxDocuments?: number;
    maxBytes?: number;
  },
): Promise<ExtractDocumentsResult> {
  const { documents, skipped } = selectExtractable(attachments, opts);
  if (!documents.length) return { extractions: [], skipped };

  const extractor = opts?.extractor ?? defaultExtractor(opts?.allowLlm);
  if (!extractor) {
    return {
      extractions: [],
      skipped: [
        ...skipped,
        ...documents.map((d) => ({
          fileName: d.fileName,
          reason:
            "document reading is not configured (set GEMINI_API_KEY or ANTHROPIC_API_KEY)",
        })),
      ],
    };
  }

  const extractions: DocumentExtraction[] = [];
  const failed: DocumentSelection["skipped"] = [];

  // Sequential on purpose. These are large multimodal calls, and an RFQ with
  // five drawings should not open five concurrent connections.
  for (const doc of documents) {
    try {
      const result = await extractor(doc);
      if (result) {
        extractions.push(result);
      } else {
        failed.push({ fileName: doc.fileName, reason: "could not be read" });
      }
    } catch (err) {
      failed.push({
        fileName: doc.fileName,
        reason: `could not be read: ${(err as Error).message}`,
      });
    }
  }

  return { extractions, skipped: [...skipped, ...failed] };
}

export type DocumentProvider = "anthropic" | "gemini";

/**
 * Which provider reads documents.
 *
 * `DOCUMENT_MODEL_PROVIDER` names one explicitly. Unset, the first provider
 * with a key configured wins, in the order below. Returning `undefined` — no
 * key at all — is a supported state, not an error: the attachments are recorded
 * as unread with the reason stated, and the draft proceeds from the body.
 */
export function selectProvider(): DocumentProvider | undefined {
  const explicit = process.env.DOCUMENT_MODEL_PROVIDER?.trim().toLowerCase();
  if (explicit === "none") return undefined;
  if (explicit === "anthropic" || explicit === "gemini") {
    return hasKey(explicit) ? explicit : undefined;
  }
  if (hasKey("anthropic")) return "anthropic";
  if (hasKey("gemini")) return "gemini";
  return undefined;
}

function hasKey(provider: DocumentProvider): boolean {
  return provider === "anthropic"
    ? Boolean(process.env.ANTHROPIC_API_KEY)
    : Boolean(process.env.GEMINI_API_KEY);
}

function defaultExtractor(allowLlm?: boolean): DocumentExtractor | undefined {
  if (allowLlm === false) return undefined;
  const provider = selectProvider();
  if (!provider) return undefined;

  if (provider === "gemini") {
    return async (doc) => {
      const { extractWithGemini } = await import("./geminiExtract");
      return extractWithGemini(doc);
    };
  }
  return async (doc) => {
    const { extractWithClaude } = await import("./anthropicExtract");
    return extractWithClaude(doc);
  };
}
