import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { QuoteLineEditor } from "@/components/QuoteLineEditor";
import { ReviewActions } from "@/components/ReviewActions";
import { ConfidenceBadge } from "@/components/ConfidenceBadge";

export const dynamic = "force-dynamic";

function buildCopyText(args: {
  subject: string | null;
  answerType: string;
  declineReason: string | null;
  lines: Array<{
    lineNumber: number;
    description: string;
    qty: number;
    unitPrice: number | null;
    confidenceState: string;
    clarification: string | null;
    assumption: { text: string } | null;
  }>;
  total: number | null;
}) {
  const header = `Re: ${args.subject ?? "Your RFQ"}\n\n`;
  if (args.answerType === "decline") {
    return (
      header +
      `Unfortunately we must decline this request.\n${args.declineReason ?? ""}\n\nRegards,\nQuoteDesk / Summit Metal Fab`
    );
  }
  if (args.answerType === "clarify") {
    const qs = args.lines
      .filter((l) => l.clarification)
      .map((l) => `- ${l.clarification}`)
      .join("\n");
    return header + `Before we can price, please clarify:\n${qs}\n`;
  }
  const priced = args.lines
    .filter((l) => l.unitPrice != null)
    .map(
      (l) =>
        `${l.lineNumber}. ${l.description} — qty ${l.qty} @ $${l.unitPrice!.toFixed(2)} = $${(l.unitPrice! * l.qty).toFixed(2)}`,
    )
    .join("\n");
  const assumptions = args.lines
    .filter((l) => l.assumption)
    .map((l) => `- ${l.assumption!.text}`)
    .join("\n");
  const clarifications = args.lines
    .filter((l) => l.clarification)
    .map((l) => `- ${l.clarification}`)
    .join("\n");

  let out = header + `Please find our quote:\n\n${priced}\n`;
  if (args.total != null) out += `\nTotal: $${args.total.toFixed(2)}\n`;
  if (assumptions) out += `\nAssumptions & exclusions:\n${assumptions}\n`;
  if (clarifications) out += `\nOpen items:\n${clarifications}\n`;
  out += `\nRegards,\nAlex Rivera\nSummit Metal Fab`;
  return out;
}

export default async function RfqReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const rfq = await prisma.rfq.findUnique({
    where: { id },
    include: {
      account: true,
      lines: { orderBy: { lineNumber: "asc" } },
      quote: {
        include: {
          lines: {
            orderBy: { lineNumber: "asc" },
            include: { assumption: true, priceBasis: true },
          },
          outcome: true,
        },
      },
    },
  });

  if (!rfq || !rfq.quote) notFound();

  /**
   * Attachments carry the specification on most real RFQs, so the estimator has
   * to be able to tell an attachment that was read from one that was skipped.
   * Silence about a skipped drawing reads as "understood", which is the wrong
   * and expensive assumption.
   */
  const attachments = (
    JSON.parse(rfq.rawRefs || "[]") as Array<{
      fileName?: string;
      mimeType?: string;
      read?: boolean;
      lineCount?: number;
      note?: string | null;
    }>
  )
    .filter((a) => a.fileName && a.mimeType !== "text/plain")
    .map((a) => ({
      fileName: a.fileName!,
      read: a.read ?? false,
      lineCount: a.lineCount ?? 0,
      note: a.note ?? null,
    }));

  const copyText = buildCopyText({
    subject: rfq.subject,
    answerType: rfq.quote.answerType,
    declineReason: rfq.quote.declineReason,
    lines: rfq.quote.lines,
    total: rfq.quote.total,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-[var(--ink-muted)]">
            {rfq.account?.name ?? rfq.fromEmail ?? "Unknown"} · {rfq.channel} ·{" "}
            {rfq.status}
          </p>
          <h1 className="font-[family-name:var(--font-plex-serif)] text-2xl text-[var(--brand)] sm:text-3xl">
            {rfq.subject ?? "RFQ review"}
          </h1>
          <p className="mt-1 text-sm text-[var(--ink-muted)]">
            Answer type:{" "}
            <span className="font-medium text-[var(--ink)]">
              {rfq.quote.answerType.replaceAll("_", " ")}
            </span>
            {rfq.deadline && ` · Quote by ${rfq.deadline.toLocaleDateString()}`}
          </p>
        </div>
        <ReviewActions
          rfqId={rfq.id}
          quoteId={rfq.quote.id}
          sentAt={rfq.quote.sentAt}
          copyText={copyText}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Source — left */}
        <section className="rounded-lg border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)]">
          <header className="border-b border-[var(--line)] px-4 py-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
              Source
            </h2>
          </header>
          <div className="space-y-4 p-4">
            <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded bg-[var(--bg)] p-3 font-mono text-xs leading-relaxed text-[var(--ink)]">
              {rfq.rawBody}
            </pre>
            {attachments.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                  Attachments
                </h3>
                <ul className="space-y-1.5 text-xs">
                  {attachments.map((a) => (
                    <li key={a.fileName} className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-[var(--ink)]">{a.fileName}</span>
                      {a.read ? (
                        <span className="rounded bg-[var(--green-bg)] px-1.5 py-0.5 font-medium text-[var(--green)]">
                          read · {a.lineCount} line{a.lineCount === 1 ? "" : "s"}
                        </span>
                      ) : (
                        <span className="rounded bg-[var(--amber-bg)] px-1.5 py-0.5 font-medium text-[var(--amber)]">
                          not read
                        </span>
                      )}
                      {a.note && (
                        <span className="text-[var(--ink-muted)]">{a.note}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                Extracted lines
              </h3>
              <ul className="space-y-2">
                {rfq.lines.map((line) => {
                  const ptr = JSON.parse(line.sourcePtr || "{}") as {
                    file?: string;
                    page?: number;
                    snippet?: string;
                  };
                  const fields = JSON.parse(line.extractedFields || "{}") as Record<
                    string,
                    string
                  >;
                  return (
                    <li
                      key={line.id}
                      className="rounded border border-[var(--line)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
                    >
                      <div className="flex justify-between gap-2">
                        <span className="font-medium">#{line.lineNumber}</span>
                        <span className="text-xs text-[var(--ink-muted)]">
                          conf {(line.extractConf * 100).toFixed(0)}%
                        </span>
                      </div>
                      <p className="mt-1">{fields.description ?? line.rawText}</p>
                      <p className="mt-1 text-xs text-[var(--ink-muted)]">
                        {[fields.partNumber, fields.material, fields.finish]
                          .filter(Boolean)
                          .join(" · ")}
                        {` · qty ${line.qty}`}
                      </p>
                      <p className="mt-1 text-xs text-[var(--brand)]">
                        Source: {ptr.file ?? "paste.txt"}
                        {ptr.page != null ? ` p.${ptr.page}` : ""}
                        {ptr.snippet ? ` — “${ptr.snippet.slice(0, 80)}”` : ""}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </section>

        {/* Draft — right */}
        <section className="rounded-lg border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)]">
          <header className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
              Drafted answer
            </h2>
            {rfq.quote.total != null && (
              <span className="text-sm font-semibold">
                ${rfq.quote.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            )}
          </header>
          <div className="p-4">
            {rfq.quote.answerType === "decline" && (
              <div className="mb-4 rounded border border-[var(--red)]/30 bg-[var(--red-bg)]/40 px-3 py-2 text-sm">
                <p className="font-medium text-[var(--red)]">Fast decline</p>
                <p className="mt-1">{rfq.quote.declineReason}</p>
              </div>
            )}
            {rfq.quote.lines.map((line) => (
              <QuoteLineEditor key={line.id} line={line} />
            ))}
            {rfq.quote.outcome && (
              <p className="mt-4 text-sm text-[var(--ink-muted)]">
                Outcome: <ConfidenceBadge state="GREEN" />{" "}
                <span className="font-medium text-[var(--ink)]">
                  {rfq.quote.outcome.result}
                </span>
                {rfq.quote.outcome.competitorPrice != null &&
                  ` · competitor $${rfq.quote.outcome.competitorPrice}`}
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
