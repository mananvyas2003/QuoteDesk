import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";

import { selectExtractable, DOCUMENT_LIMITS } from "../src/lib/documents/attachments";
import { applyDocumentExtractions, EXTRACTION_CONFIDENCE } from "../src/lib/documents/merge";
import { extractDocuments, type DocumentExtractor } from "../src/lib/documents";
import { buildSystemPrompt, toDocumentLine } from "../src/lib/documents/visionExtract";
import type { DocumentExtraction, DocumentLine } from "../src/lib/documents/types";
import type { InboundAttachment } from "../src/lib/email/types";
import { parseRfqInput } from "../src/lib/extract";
import { BLOCKER_CODES } from "../src/lib/types";

const dir = mkdtempSync(join(tmpdir(), "qd-docs-"));

function fileAttachment(
  fileName: string,
  bytes: Buffer,
  mimeType = "application/pdf",
): InboundAttachment {
  const path = join(dir, fileName.replace(/[^A-Za-z0-9._-]/g, "_"));
  writeFileSync(path, bytes);
  return { fileName, mimeType, size: bytes.length, storagePath: path };
}

function docLine(over: Partial<DocumentLine> = {}): DocumentLine {
  return { confidence: 0.95, ...over };
}

function extraction(
  fileName: string,
  lines: DocumentLine[],
  over: Partial<DocumentExtraction> = {},
): DocumentExtraction {
  return { fileName, lines, unreadable: false, ...over };
}

describe("attachment selection", () => {
  test("opens PDFs and images, and says why it skipped everything else", () => {
    const { documents, skipped } = selectExtractable([
      fileAttachment("print.pdf", Buffer.from("%PDF-1.7 fake")),
      fileAttachment("photo.jpg", Buffer.from("jpegbytes"), "image/jpeg"),
      fileAttachment("model.step", Buffer.from("ISO-10303"), "application/octet-stream"),
      fileAttachment("notes.docx", Buffer.from("zip"), "application/octet-stream"),
    ]);

    assert.deepEqual(
      documents.map((d) => d.fileName),
      ["print.pdf", "photo.jpg"],
    );
    assert.equal(documents[0].kind, "pdf");
    assert.equal(documents[1].kind, "image");
    assert.equal(documents[1].mimeType, "image/jpeg");

    // A CAD file is recognised-but-unread, not silently dropped: an estimator
    // told nothing would assume the geometry was understood.
    const step = skipped.find((s) => s.fileName === "model.step");
    assert.match(step!.reason, /CAD geometry is not read/);
    assert.ok(skipped.find((s) => s.fileName === "notes.docx"));
  });

  test("a PDF mislabelled application/octet-stream is still opened", () => {
    const { documents } = selectExtractable([
      fileAttachment("drawing.pdf", Buffer.from("%PDF"), "application/octet-stream"),
    ]);
    assert.equal(documents.length, 1);
    assert.equal(documents[0].mimeType, "application/pdf");
  });

  test("an oversized document is refused by size, not read", () => {
    const { documents, skipped } = selectExtractable(
      [fileAttachment("huge.pdf", Buffer.alloc(4096))],
      { maxBytes: 1024 },
    );
    assert.equal(documents.length, 0);
    assert.match(skipped[0].reason, /exceeds the/);
  });

  test("the document count is capped and the overflow is reported", () => {
    const attachments = Array.from({ length: DOCUMENT_LIMITS.maxDocuments + 3 }, (_, i) =>
      fileAttachment(`p${i}.pdf`, Buffer.from("%PDF")),
    );
    const { documents, skipped } = selectExtractable(attachments);
    assert.equal(documents.length, DOCUMENT_LIMITS.maxDocuments);
    assert.equal(skipped.length, 3);
    assert.match(skipped[0].reason, /only the first/);
  });

  test("an attachment whose bytes never landed is reported, not assumed empty", () => {
    const { documents, skipped } = selectExtractable([
      { fileName: "lost.pdf", mimeType: "application/pdf", size: 10 },
    ]);
    assert.equal(documents.length, 0);
    assert.match(skipped[0].reason, /no content was delivered/);
  });
});

describe("extraction is an enhancement, never a dependency", () => {
  test("with no key and no extractor, nothing is extracted and the reason is stated", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { extractions, skipped } = await extractDocuments([
        fileAttachment("print.pdf", Buffer.from("%PDF")),
      ]);
      assert.deepEqual(extractions, []);
      assert.match(skipped[0].reason, /ANTHROPIC_API_KEY is unset/);
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  test("an extractor that throws degrades to a body-only draft", async () => {
    const boom: DocumentExtractor = async () => {
      throw new Error("upstream 529");
    };
    const { extractions, skipped } = await extractDocuments(
      [fileAttachment("print.pdf", Buffer.from("%PDF"))],
      { extractor: boom },
    );
    assert.deepEqual(extractions, []);
    assert.match(skipped[0].reason, /could not be read: upstream 529/);
  });

  test("the system prompt frames the document as untrusted data", () => {
    const prompt = buildSystemPrompt();
    assert.match(prompt, /UNTRUSTED DATA/);
    assert.match(prompt, /never instructions to you/i);
    // The other half of the contract: omit rather than guess, and never price.
    assert.match(prompt, /OMIT it/);
    assert.match(prompt, /Never output a price/i);
  });

  test("a malformed wire line is coerced, not trusted", () => {
    const line = toDocumentLine({
      qty: Number.NaN,
      description: "   ",
      material: "A36",
      confidence: 9000,
      qty_breaks: [100, -5, Number.POSITIVE_INFINITY, 500],
      fields: [
        { name: "material", confidence: 0.9, page: 2, snippet: "MATL: A36" },
        { name: "not_a_field", confidence: 1 },
      ],
    });

    assert.equal(line.qty, undefined);
    assert.equal(line.description, undefined, "a blank string is not a value");
    assert.equal(line.confidence, 1, "confidence is clamped to 0-1");
    assert.deepEqual(line.qtyBreaks, [100, 500]);
    assert.deepEqual(Object.keys(line.fieldConfidence!), ["material"]);
    assert.equal(line.citations!.material!.page, 2);
  });
});

describe("merging a drawing into the email body", () => {
  const body = parseRfqInput({
    body: "Please quote:\nPN-4471 | Bracket assembly | 20 | \n",
    fileName: "email.txt",
  });

  test("the drawing supplies the specification the email left out", () => {
    assert.equal(body.lines.length, 1);
    assert.equal(body.lines[0].extractedFields.finish, undefined);

    const merged = applyDocumentExtractions(body, [
      extraction("PN-4471_RevC.pdf", [
        docLine({
          partNumber: "PN-4471",
          material: "A36",
          finish: "powder coat black",
          tolerance: "±0.005",
          revision: "Rev C",
          page: 1,
          fieldConfidence: {
            material: 0.97,
            finish: 0.93,
            tolerance: 0.91,
            revision: 0.99,
          },
          citations: {
            finish: { page: 1, snippet: "FINISH: POWDER COAT BLACK" },
          },
        }),
      ]),
    ]);

    // Still one line: the drawing enriched the email line rather than duplicating it.
    assert.equal(merged.lines.length, 1);
    const fields = merged.lines[0].extractedFields;
    assert.equal(fields.finish, "powder coat black");
    assert.equal(fields.tolerance, "±0.005");
    assert.equal(fields.revision, "Rev C");

    // PRD 5.1: nothing is extracted that cannot be cited back to a location.
    assert.equal(fields.sources!.finish!.file, "PN-4471_RevC.pdf");
    assert.equal(fields.sources!.finish!.page, 1);
    assert.match(fields.sources!.finish!.snippet!, /POWDER COAT BLACK/);
  });

  test("the body wins where both speak", () => {
    const withMaterial = parseRfqInput({
      body: "Please quote:\nPN-4471 | Bracket assembly | 20 | SS304\n",
      fileName: "email.txt",
    });
    assert.equal(withMaterial.lines[0].extractedFields.material, "SS304");

    const merged = applyDocumentExtractions(withMaterial, [
      extraction("print.pdf", [
        docLine({ partNumber: "PN-4471", material: "A36", fieldConfidence: { material: 0.99 } }),
      ]),
    ]);
    assert.equal(merged.lines[0].extractedFields.material, "SS304");
  });

  test("a field the model could not read clearly is dropped, not carried", () => {
    const merged = applyDocumentExtractions(body, [
      extraction("smudged.pdf", [
        docLine({
          partNumber: "PN-4471",
          material: "A36",
          finish: "zinc",
          fieldConfidence: {
            material: 0.99,
            // Below the floor: a guessed finish would produce a confidently
            // wrong GREEN, whereas an absent one produces AMBER with a
            // published assumption.
            finish: EXTRACTION_CONFIDENCE.minField - 0.01,
          },
        }),
      ]),
    ]);
    assert.equal(merged.lines[0].extractedFields.material, "A36");
    assert.equal(merged.lines[0].extractedFields.finish, undefined);
  });

  test("a barely legible line carries degraded_input, an existing blocker code", () => {
    const merged = applyDocumentExtractions(body, [
      extraction("faxed.pdf", [
        docLine({
          partNumber: "PN-4471",
          material: "A36",
          confidence: EXTRACTION_CONFIDENCE.minLine - 0.1,
          fieldConfidence: { material: 0.8 },
        }),
      ]),
    ]);
    const blocker = merged.lines[0].blockers.find(
      (b) => b.code === BLOCKER_CODES.degradedInput,
    );
    assert.ok(blocker, "expected the existing degraded_input blocker");
    assert.equal(blocker!.kind, "assumable");
    assert.match(blocker!.detail, /faxed\.pdf/);
  });

  test("a drawing that contradicts the email quantity raises qty_conflict", () => {
    const merged = applyDocumentExtractions(body, [
      extraction("print.pdf", [docLine({ partNumber: "PN-4471", qty: 500 })]),
    ]);

    const blocker = merged.lines[0].blockers.find(
      (b) => b.code === BLOCKER_CODES.qtyConflict,
    );
    assert.ok(blocker, "a contradiction we cannot resolve must not be priced");
    assert.equal(blocker!.kind, "unassumable", "unassumable means RED, not a guess");
    assert.match(blocker!.detail, /20.*500|500.*20/);
    assert.ok(merged.conflicts.some((c) => /disagrees with print\.pdf/.test(c)));
  });

  test("a part only the drawing mentions becomes its own line", () => {
    const merged = applyDocumentExtractions(body, [
      extraction("assembly.pdf", [
        docLine({
          partNumber: "PN-9002",
          description: "Gusset",
          qty: 40,
          material: "A36",
          page: 3,
          snippet: "ITEM 2  GUSSET  QTY 40",
        }),
      ]),
    ]);

    assert.equal(merged.lines.length, 2);
    const added = merged.lines[1];
    assert.equal(added.lineNumber, 2, "lines are renumbered contiguously");
    assert.equal(added.extractedFields.partNumber, "PN-9002");
    assert.equal(added.qty, 40);
    assert.equal(added.sourcePtr.file, "assembly.pdf");
    assert.equal(added.sourcePtr.page, 3);
  });

  test("a drawing line with no quantity is quoted as one piece", () => {
    const merged = applyDocumentExtractions(
      parseRfqInput({ body: "Drawing attached, please quote.", fileName: "email.txt" }),
      [extraction("single.pdf", [docLine({ partNumber: "PN-1", material: "A36" })])],
    );
    const line = merged.lines.find((l) => l.extractedFields.partNumber === "PN-1");
    assert.ok(line);
    assert.equal(line!.qty, 1, "assuming a larger run would understate unit price");
  });

  test("attachments that were not read are stated on the RFQ", () => {
    const merged = applyDocumentExtractions(body, [], [
      { fileName: "weldment.dxf", reason: "CAD geometry is not read in this build" },
    ]);
    assert.ok(
      merged.conflicts.some((c) => /weldment\.dxf was not read/.test(c)),
      "silence would look like the file was understood",
    );
  });

  test("no extractions leaves the body-only parse byte-identical", () => {
    const merged = applyDocumentExtractions(body, []);
    assert.deepEqual(merged.lines, body.lines);
    assert.deepEqual(merged.conflicts, body.conflicts);
  });
});
