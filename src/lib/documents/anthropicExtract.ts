import {
  buildSystemPrompt,
  openDocumentTag,
  toDocumentLine,
  USER_INSTRUCTION,
  type RawLine,
} from "./prompt";
import type { DocumentExtraction, ExtractableDocument } from "./types";

/**
 * Anthropic document extraction.
 *
 * The prompt and the output normalisation come from `prompt.ts`, shared with
 * the Gemini path, so the two providers cannot drift on what "extracted"
 * means. Only the wire format differs, and that difference is confined here.
 */

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          qty: { type: ["number", "null"] },
          qty_breaks: { type: "array", items: { type: "number" } },
          description: { type: ["string", "null"] },
          part_number: { type: ["string", "null"] },
          material: { type: ["string", "null"] },
          finish: { type: ["string", "null"] },
          tolerance: { type: ["string", "null"] },
          revision: { type: ["string", "null"] },
          page: { type: ["number", "null"] },
          snippet: { type: ["string", "null"] },
          confidence: { type: "number" },
          fields: {
            type: "array",
            description: "Per-field legibility and citation.",
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
                page: { type: ["number", "null"] },
                snippet: { type: ["string", "null"] },
              },
              required: ["name", "confidence"],
              additionalProperties: false,
            },
          },
        },
        required: ["confidence", "fields"],
        additionalProperties: false,
      },
    },
    note: {
      type: ["string", "null"],
      description: "One sentence for the estimator when little or nothing was readable.",
    },
  },
  required: ["lines"],
  additionalProperties: false,
} as const;

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

export async function extractWithClaude(
  doc: ExtractableDocument,
): Promise<DocumentExtraction | null> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();

  const source = {
    type: "base64" as const,
    media_type: doc.mimeType,
    data: doc.contentBase64,
  };

  const response = await client.messages.create(
    {
      model: process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: buildSystemPrompt(),
      output_config: {
        format: { type: "json_schema", schema: RESPONSE_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: openDocumentTag(doc.fileName) },
            doc.kind === "pdf"
              ? {
                  type: "document",
                  source: { ...source, media_type: "application/pdf" },
                }
              : { type: "image", source },
            { type: "text", text: USER_INSTRUCTION },
          ],
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // Reading a multi-page drawing is not a fast call.
    { timeout: 120_000 },
  );

  if (response.stop_reason === "refusal") return null;

  const parsed = parseResponse(response);
  if (!parsed) return null;

  return {
    fileName: doc.fileName,
    lines: parsed.lines.map(toDocumentLine),
    note: parsed.note ?? undefined,
    unreadable: false,
  };
}

function parseResponse(
  response: unknown,
): { lines: RawLine[]; note?: string | null } | null {
  const blocks = (response as { content?: Array<{ type: string; text?: string }> })
    .content;
  const text = blocks?.find((b) => b.type === "text")?.text;
  if (!text) return null;
  try {
    const json = JSON.parse(text) as { lines?: RawLine[]; note?: string | null };
    if (!Array.isArray(json.lines)) return null;
    return { lines: json.lines, note: json.note };
  } catch {
    return null;
  }
}
