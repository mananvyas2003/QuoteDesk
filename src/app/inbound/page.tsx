import Link from "next/link";
import { prisma } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";
import { ConfidenceBadge } from "@/components/ConfidenceBadge";

export const dynamic = "force-dynamic";

type Classification = {
  isRfq: boolean;
  confidence: number;
  reason: string;
  signals?: string[];
  classifier?: string;
};

const STATUS_LABEL: Record<string, string> = {
  received: "Received",
  classified_rfq: "Classified as RFQ",
  skipped_not_rfq: "Skipped — not an RFQ",
  drafted: "Drafted",
  error: "Error",
};

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export default async function InboundPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { workspace } = await getWorkspaceContext();
  const { status } = await searchParams;

  const emails = await prisma.inboundEmail.findMany({
    where: {
      workspaceId: workspace.id,
      ...(status && status !== "all" ? { status } : {}),
    },
    orderBy: { receivedAt: "desc" },
    take: 100,
    include: { rfq: { include: { quote: { include: { lines: true } } } } },
  });

  const counts = await prisma.inboundEmail.groupBy({
    by: ["status"],
    where: { workspaceId: workspace.id },
    _count: { _all: true },
  });
  const countFor = (s: string) =>
    counts.find((c) => c.status === s)?._count._all ?? 0;
  const total = counts.reduce((sum, c) => sum + c._count._all, 0);

  const filters = [
    { key: "all", label: "All", count: total },
    { key: "drafted", label: "Drafted", count: countFor("drafted") },
    { key: "skipped_not_rfq", label: "Skipped", count: countFor("skipped_not_rfq") },
    { key: "error", label: "Errors", count: countFor("error") },
  ];
  const active = status ?? "all";

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-[var(--ink-muted)]">{workspace.name}</p>
        <h1 className="font-[family-name:var(--font-plex-serif)] text-3xl text-[var(--brand)]">
          Inbound mail
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--ink-muted)]">
          Every email received on the ingest channel, including the ones that were
          not RFQs. Nothing is dropped silently — a skipped email keeps the reason
          it was skipped, so a misclassification is visible rather than invisible.
        </p>
      </div>

      <nav className="flex flex-wrap gap-2">
        {filters.map((f) => (
          <Link
            key={f.key}
            href={f.key === "all" ? "/inbound" : `/inbound?status=${f.key}`}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              active === f.key
                ? "border-[var(--brand)] bg-[var(--brand)] text-white"
                : "border-[var(--line)] bg-[var(--panel)] text-[var(--ink-muted)] hover:text-[var(--ink)]"
            }`}
          >
            {f.label} ({f.count})
          </Link>
        ))}
      </nav>

      {emails.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--line)] bg-[var(--panel)] p-10 text-center">
          <p className="text-[var(--ink-muted)]">
            No inbound mail yet. Point a provider at{" "}
            <code className="font-mono text-xs">/api/inbound-email</code>, or run{" "}
            <code className="font-mono text-xs">npm run mail:fixture</code>.
          </p>
          <Link
            href="/settings"
            className="mt-4 inline-block text-sm font-medium text-[var(--brand)]"
          >
            Webhook setup →
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--line)] overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)]">
          {emails.map((email) => {
            const c = parse<Classification | null>(email.classification, null);
            const attachments = parse<Array<{ fileName: string }>>(email.attachments, []);
            const states = email.rfq?.quote?.lines.map((l) => l.confidenceState) ?? [];
            const dominant = states.includes("RED")
              ? "RED"
              : states.includes("AMBER")
                ? "AMBER"
                : states.length
                  ? "GREEN"
                  : null;

            return (
              <li key={email.id} className="px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{email.subject ?? "(no subject)"}</p>
                    <p className="text-sm text-[var(--ink-muted)]">
                      {email.fromName ? `${email.fromName} · ` : ""}
                      {email.fromEmail} · {email.receivedAt.toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {dominant && <ConfidenceBadge state={dominant} />}
                    <span
                      className={`rounded px-2 py-1 text-xs font-medium ${
                        email.status === "drafted"
                          ? "bg-[var(--green-bg)] text-[var(--green)]"
                          : email.status === "error"
                            ? "bg-[var(--red-bg)] text-[var(--red)]"
                            : "bg-[var(--bg-elevated)] text-[var(--ink-muted)]"
                      }`}
                    >
                      {STATUS_LABEL[email.status] ?? email.status}
                    </span>
                  </div>
                </div>

                {c && (
                  <p className="mt-2 text-xs text-[var(--ink-muted)]">
                    <span className="font-medium text-[var(--ink)]">
                      {c.isRfq ? "RFQ" : "Not an RFQ"}
                    </span>{" "}
                    · certainty {(c.confidence * 100).toFixed(0)}%
                    {c.classifier ? ` · ${c.classifier}` : ""} — {c.reason}
                  </p>
                )}

                {attachments.length > 0 && (
                  <p className="mt-1 text-xs text-[var(--ink-muted)]">
                    Attachments (stored, not read — no OCR in this build):{" "}
                    {attachments.map((a) => a.fileName).join(", ")}
                  </p>
                )}

                {email.error && (
                  <p className="mt-1 text-xs text-[var(--red)]">Error: {email.error}</p>
                )}

                {email.rfqId && (
                  <Link
                    href={`/rfqs/${email.rfqId}`}
                    className="mt-2 inline-block text-sm font-medium text-[var(--brand)]"
                  >
                    Review draft →
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
