import Link from "next/link";
import { prisma } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";
import { updateSettingsAction } from "@/lib/actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { workspace } = await getWorkspaceContext({ requireCorpus: false });
  const envelope = JSON.parse(workspace.capabilityEnvelope || "{}") as {
    materials?: string[];
    maxLeadDays?: number;
    minOrderValue?: number;
  };

  const editCount = await prisma.editEvent.count({
    where: { user: { workspaceId: workspace.id } },
  });
  const greenEdits = await prisma.editEvent.count({
    where: {
      user: { workspaceId: workspace.id },
      quoteLine: { confidenceState: "GREEN" },
    },
  });

  const inboundTotal = await prisma.inboundEmail.count({
    where: { workspaceId: workspace.id },
  });
  const inboundDrafted = await prisma.inboundEmail.count({
    where: { workspaceId: workspace.id, status: "drafted" },
  });
  const inboundSkipped = await prisma.inboundEmail.count({
    where: { workspaceId: workspace.id, status: "skipped_not_rfq" },
  });
  const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

  return (
    <div className="mx-auto max-w-xl space-y-8">
      <div>
        <h1 className="font-[family-name:var(--font-plex-serif)] text-3xl text-[var(--brand)]">
          Settings
        </h1>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">
          Controller controls: margin floor and capability envelope. These gate
          GREEN/AMBER/RED behaviour.
        </p>
      </div>

      <form
        action={updateSettingsAction}
        className="space-y-4 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]"
      >
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Margin floor (%)</span>
          <input
            name="marginFloorPct"
            type="number"
            step="0.1"
            defaultValue={workspace.marginFloorPct}
            className="w-full rounded border border-[var(--line)] bg-white px-3 py-2"
          />
          <span className="mt-1 block text-xs text-[var(--ink-muted)]">
            Any derived price that would fall below this floor is forced to AMBER.
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            name="requireCostForGreen"
            type="checkbox"
            defaultChecked={workspace.requireCostForGreen}
            className="mt-1"
          />
          <span>
            <span className="font-medium">Require a cost record for GREEN</span>
            <span className="mt-1 block text-xs text-[var(--ink-muted)]">
              When no cost record resolves, margin cannot be checked against the
              floor. With this on, such a line is held at AMBER rather than passing
              silently.
            </span>
          </span>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Materials (comma-separated)</span>
          <input
            name="materials"
            defaultValue={(envelope.materials ?? []).join(", ")}
            className="w-full rounded border border-[var(--line)] bg-white px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Max lead time (days)</span>
          <input
            name="maxLeadDays"
            type="number"
            defaultValue={envelope.maxLeadDays ?? 45}
            className="w-full rounded border border-[var(--line)] bg-white px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Minimum order value ($)</span>
          <input
            name="minOrderValue"
            type="number"
            defaultValue={envelope.minOrderValue ?? 250}
            className="w-full rounded border border-[var(--line)] bg-white px-3 py-2"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white"
        >
          Save
        </button>
      </form>

      <div className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-6 text-sm">
        <h2 className="font-semibold">Inbound email</h2>
        <p className="mt-2 text-[var(--ink-muted)]">
          Ingest address:{" "}
          <span className="font-medium text-[var(--ink)]">
            {workspace.ingestEmail ?? "not set"}
          </span>
        </p>
        <p className="mt-3 text-[var(--ink-muted)]">
          Have the shop forward or auto-forward that mailbox to your inbound-parse
          provider, and point the provider&apos;s webhook at:
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-[var(--bg)] p-3 font-mono text-xs">
          POST {appUrl}/api/inbound-email{"\n"}
          X-QuoteDesk-Secret: &lt;INBOUND_WEBHOOK_SECRET&gt;
        </pre>
        <p className="mt-2 text-xs text-[var(--ink-muted)]">
          Postmark, SendGrid, Resend and Mailgun payload shapes are accepted, as is
          a raw MIME body. The endpoint returns 503 until{" "}
          <code className="font-mono">INBOUND_WEBHOOK_SECRET</code> is set — it will
          not accept unauthenticated mail.
        </p>
        <p className="mt-3 text-[var(--ink-muted)]">
          Received {inboundTotal} email{inboundTotal === 1 ? "" : "s"} ·{" "}
          {inboundDrafted} drafted · {inboundSkipped} skipped as not-an-RFQ.{" "}
          <Link href="/inbound" className="font-medium text-[var(--brand)]">
            Inbound mail →
          </Link>
        </p>
        <p className="mt-3 text-xs text-[var(--ink-muted)]">
          Inbound mail is drafted and the estimator is notified. Nothing is sent to
          a buyer without an explicit action on the review screen.
        </p>
      </div>

      <div className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-6 text-sm">
        <h2 className="font-semibold">Trust proxy (K4)</h2>
        <p className="mt-2 text-[var(--ink-muted)]">
          Edit events captured: {editCount}. Edits on GREEN lines: {greenEdits}.
          Target after 4 weeks live: ≤30% edit rate on GREEN.
        </p>
      </div>
    </div>
  );
}
