import Link from "next/link";
import { prisma } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";
import { ConfidenceBadge } from "@/components/ConfidenceBadge";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const { workspace, user } = await getWorkspaceContext();

  if (!workspace.onboardedAt) {
    return (
      <div className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-8 shadow-[var(--shadow)]">
        <h1 className="font-[family-name:var(--font-plex-serif)] text-2xl text-[var(--brand)]">
          Cold start required
        </h1>
        <p className="mt-2 max-w-xl text-[var(--ink-muted)]">
          No history, no onboarding. Load quote history, set the margin floor, and
          capture the capability envelope before go-live.
        </p>
        <Link
          href="/onboarding"
          className="mt-6 inline-block rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white"
        >
          Start onboarding
        </Link>
      </div>
    );
  }

  const rfqs = await prisma.rfq.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { receivedAt: "desc" },
    include: {
      account: true,
      quote: { include: { lines: true, outcome: true } },
    },
    take: 50,
  });

  const answered = rfqs.filter((r) => r.status === "sent" || r.status === "closed").length;
  const coverage = rfqs.length ? Math.round((answered / rfqs.length) * 100) : 0;

  // Drafts waiting on a human. Nothing here has been sent to a customer.
  const notifications = await prisma.notification.findMany({
    where: { workspaceId: workspace.id, readAt: null },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const skippedMail = await prisma.inboundEmail.count({
    where: { workspaceId: workspace.id, status: "skipped_not_rfq" },
  });

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-[var(--ink-muted)]">{workspace.name}</p>
          <h1 className="font-[family-name:var(--font-plex-serif)] text-3xl text-[var(--brand)]">
            RFQ inbox
          </h1>
          <p className="mt-1 text-sm text-[var(--ink-muted)]">
            Signed in as {user.name} · Answer coverage (session): {coverage}%
          </p>
        </div>
        <Link
          href="/rfqs/new"
          className="rounded-md bg-[var(--brand-hot)] px-4 py-2 text-sm font-semibold text-white"
        >
          Ingest RFQ
        </Link>
      </div>

      {notifications.length > 0 && (
        <section className="rounded-lg border border-[var(--amber)]/40 bg-[var(--amber-bg)]/50 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--amber)]">
              Waiting for review
            </h2>
            <Link href="/inbound" className="text-xs font-medium text-[var(--brand)]">
              Inbound mail{skippedMail ? ` · ${skippedMail} skipped` : ""} →
            </Link>
          </div>
          <ul className="mt-2 space-y-2">
            {notifications.map((n) => (
              <li key={n.id} className="text-sm">
                <Link
                  href={n.linkPath ?? "/inbound"}
                  className="font-medium text-[var(--ink)] hover:text-[var(--brand)]"
                >
                  {n.title}
                </Link>
                {n.body && (
                  <p className="text-xs text-[var(--ink-muted)]">{n.body}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {rfqs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--line)] bg-[var(--panel)] p-10 text-center">
          <p className="text-[var(--ink-muted)]">No RFQs yet. Paste an inbound email to draft an answer.</p>
          <Link href="/rfqs/new" className="mt-4 inline-block text-sm font-medium text-[var(--brand)]">
            Open ingest →
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--line)] overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)]">
          {rfqs.map((rfq) => {
            const states = rfq.quote?.lines.map((l) => l.confidenceState) ?? [];
            const dominant =
              states.includes("RED") ? "RED" : states.includes("AMBER") ? "AMBER" : states.length ? "GREEN" : "RED";
            return (
              <li key={rfq.id}>
                <Link
                  href={`/rfqs/${rfq.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 hover:bg-[var(--bg-elevated)]"
                >
                  <div>
                    <p className="flex items-center gap-2 font-medium">
                      {rfq.subject ?? "Untitled RFQ"}
                      {rfq.channel === "email" && (
                        <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                          Email
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-[var(--ink-muted)]">
                      {rfq.account?.name ?? rfq.fromEmail ?? "Unknown account"} ·{" "}
                      {rfq.receivedAt.toLocaleString()} · {rfq.status}
                      {rfq.quote ? ` · ${rfq.quote.answerType.replaceAll("_", " ")}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {rfq.quote && <ConfidenceBadge state={dominant} />}
                    {rfq.quote?.total != null && (
                      <span className="text-sm font-medium">
                        ${rfq.quote.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
