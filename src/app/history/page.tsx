import { prisma } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const { workspace } = await getWorkspaceContext();
  const quotes = await prisma.historicalQuote.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { quotedAt: "desc" },
    include: { account: true, lines: true },
  });
  const lineCount = quotes.reduce((s, q) => s + q.lines.length, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-plex-serif)] text-3xl text-[var(--brand)]">
          Quote history
        </h1>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">
          {quotes.length} quotes · {lineCount} priced lines — the price-basis corpus
        </p>
      </div>
      <ul className="divide-y divide-[var(--line)] overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--panel)]">
        {quotes.map((q) => (
          <li key={q.id} className="px-4 py-4">
            <div className="flex flex-wrap justify-between gap-2">
              <div>
                <p className="font-medium">
                  {q.quoteNumber} · {q.account?.name ?? "No account"}
                </p>
                <p className="text-sm text-[var(--ink-muted)]">
                  {q.quotedAt.toLocaleDateString()} · {q.lines.length} lines
                </p>
              </div>
              {q.total != null && (
                <p className="font-medium">
                  ${q.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </p>
              )}
            </div>
            <ul className="mt-2 space-y-1 text-sm text-[var(--ink-muted)]">
              {q.lines.map((l) => (
                <li key={l.id}>
                  {l.partNumber ?? "—"} {l.description} · qty {l.qty} @ $
                  {l.unitPrice.toFixed(2)}
                  {l.material ? ` · ${l.material}` : ""}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
