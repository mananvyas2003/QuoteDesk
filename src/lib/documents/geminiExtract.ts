import {
  buildSystemPrompt,
  openDocumentTag,
  toDocumentLine,
  USER_INSTRUCTION,
  type RawLine,
} from "./prompt";
import type { DocumentExtraction, ExtractableDocument } from "./types";

/**
 * Gemini document extraction, over the REST API.
 *
 * No SDK: the repo keeps dependencies to a minimum, and this is one POST with a
 * JSON body. Node's built-in `fetch` is enough.
 *
 * The prompt and the output normalisation come from `prompt.ts`, shared with
 * the Anthropic path, so the two providers cannot drift on what "extracted"
 * means. Only the wire format differs, and that difference is confined here.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Pinned deliberately, not `gemini-flash-latest`.
 *
 * A moving alias silently changes model behaviour underneath a system whose
 * whole premise is that behaviour is measured. When the model changes, that
 * should be a commit with a re-run behind it, not a Tuesday.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

/**
 * Gemini's schema dialect is OpenAPI-flavoured, not JSON Schema: nullability is
 * `nullable: true` rather than a type union, and `additionalProperties` is not
 * accepted. Same contract as the Anthropic schema, different spelling.
 */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          qty: { type: "integer", nullable: true },
          qty_breaks: { type: "array", items: { type: "integer" }, nullable: true },
          description: { type: "string", nullable: true },
          part_number: { type: "string", nullable: true },
          material: { type: "string", nullable: true },
          finish: { type: "string", nullable: true },
          tolerance: { type: "string", nullable: true },
          revision: { type: "string", nullable: true },
          page: { type: "integer", nullable: true },
          snippet: { type: "string", nullable: true },
          confidence: { type: "number" },
          fields: {
            type: "array",
            nullable: true,
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  enum: [
                    "description",
                    "partNumber",
                    "material",
                    "finish",
                    "tolerance",
                    "revision",
                  ],
                },
                confidence: { type: "number" },
                page: { type: "integer", nullable: true },
                snippet: { type: "string", nullable: true },
              },
              required: ["name", "confidence"],
            },
          },
        },
        required: ["confidence"],
      },
    },
    note: { type: "string", nullable: true },
  },
  required: ["lines"],
} as const;

/** Exported so a test can assert the dialect without a network call. */
export function buildRequestBody(doc: ExtractableDocument): unknown {
  return {
    systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: openDocumentTag(doc.fileName) },
          { inline_data: { mime_type: doc.mimeType, data: doc.contentBase64 } },
          { text: USER_INSTRUCTION },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };
}

/**
 * Statuses worth retrying.
 *
 * 503 is not an edge case on the free tier — the popular models return "high
 * demand" routinely, and without a retry a drawing would fail to be read for
 * reasons that have nothing to do with the drawing. 429 is the rate limit;
 * 500/502/504 are transient.
 */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export type GeminiOptions = {
  apiKey?: string;
  model?: string;
  /** Total attempts, including the first. */
  attempts?: number;
  /** Injected in tests so retry behaviour is provable without a network. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so a backoff does not make the suite slow. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

export async function extractWithGemini(
  doc: ExtractableDocument,
  opts: GeminiOptions = {},
): Promise<DocumentExtraction | null> {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const model = opts.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
  const attempts = opts.attempts ?? 3;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const body = JSON.stringify(buildRequestBody(doc));

  let lastStatus = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await doFetch(
      `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // In a header, not the query string: a key in a URL leaks into logs,
          // proxies and error messages.
          "x-goog-api-key": apiKey,
        },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      },
    );

    if (response.ok) {
      const parsed = parseResponse(await response.json());
      if (!parsed) return null;
      return {
        fileName: doc.fileName,
        lines: parsed.lines.map(toDocumentLine),
        note: parsed.note ?? undefined,
        unreadable: false,
      };
    }

    lastStatus = response.status;
    if (!RETRYABLE.has(response.status) || attempt === attempts) break;
    // 1s, 2s, 4s. The caller records the attachment as unread if we give up.
    await sleep(2 ** (attempt - 1) * 1000);
  }

  throw new Error(`Gemini returned HTTP ${lastStatus}`);
}

type GeminiResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string }> };
  }>;
  promptFeedback?: { blockReason?: string };
};

function parseResponse(
  json: unknown,
): { lines: RawLine[]; note?: string | null } | null {
  const res = json as GeminiResponse;
  if (res.promptFeedback?.blockReason) return null;

  const candidate = res.candidates?.[0];
  // A truncated response is not a partial answer — the JSON will not parse, and
  // half a specification is worse than none.
  if (!candidate || candidate.finishReason === "SAFETY") return null;

  const text = (candidate.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as { lines?: RawLine[]; note?: string | null };
    if (!Array.isArray(parsed.lines)) return null;
    return { lines: parsed.lines, note: parsed.note };
  } catch {
    return null;
  }
}
