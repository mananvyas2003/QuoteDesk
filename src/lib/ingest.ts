import { prisma } from "./db";
import { parseRfqInput } from "./extract";
import { draftQuoteForRfq } from "./draft";

export async function ingestRfq(input: {
  workspaceId: string;
  subject?: string;
  fromEmail?: string;
  fromName?: string;
  body: string;
  channel?: string;
  fileName?: string;
}) {
  const parsed = parseRfqInput({
    subject: input.subject,
    fromEmail: input.fromEmail,
    fromName: input.fromName,
    body: input.body,
    fileName: input.fileName,
  });

  let accountId: string | undefined;
  if (parsed.accountHint || input.fromEmail) {
    const domain = input.fromEmail?.split("@")[1];
    const existing = await prisma.account.findFirst({
      where: {
        workspaceId: input.workspaceId,
        OR: [
          ...(domain ? [{ domain }] : []),
          ...(parsed.accountHint
            ? [{ name: { contains: parsed.accountHint } }]
            : []),
        ],
      },
    });
    if (existing) {
      accountId = existing.id;
    } else if (parsed.accountHint) {
      const created = await prisma.account.create({
        data: {
          workspaceId: input.workspaceId,
          name: parsed.accountHint,
          domain: domain ?? null,
        },
      });
      accountId = created.id;
    }
  }

  const rfq = await prisma.rfq.create({
    data: {
      workspaceId: input.workspaceId,
      accountId,
      subject: parsed.subject ?? input.subject ?? "Inbound RFQ",
      fromEmail: parsed.fromEmail ?? input.fromEmail,
      fromName: parsed.fromName ?? input.fromName,
      rawBody: parsed.body,
      deadline: parsed.deadline,
      channel: input.channel ?? "upload",
      rawRefs: JSON.stringify(
        input.fileName
          ? [{ fileName: input.fileName, mimeType: "text/plain", storagePath: null }]
          : [],
      ),
      status: "ingested",
      lines: {
        create: parsed.lines.map((l) => ({
          lineNumber: l.lineNumber,
          rawText: l.rawText,
          qty: l.qty,
          qtyBreaks: JSON.stringify(l.qtyBreaks),
          extractedFields: JSON.stringify(l.extractedFields),
          sourcePtr: JSON.stringify(l.sourcePtr),
          extractConf: l.extractConf,
          extractionBlockers: JSON.stringify(l.blockers),
        })),
      },
    },
    include: { lines: true },
  });

  const quote = await draftQuoteForRfq(rfq.id);

  return { rfq, quote, conflicts: parsed.conflicts };
}
