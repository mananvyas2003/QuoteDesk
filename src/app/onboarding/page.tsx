import { completeOnboardingAction } from "@/lib/actions";
import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const { workspace } = await getWorkspaceContext({ requireCorpus: false });
  const lineCount = await prisma.historicalQuoteLine.count({
    where: { historicalQuote: { workspaceId: workspace.id } },
  });
  const costCount = await prisma.costRecord.count({ where: { workspaceId: workspace.id } });
  const distinctItems = (
    await prisma.historicalQuoteLine.findMany({
      where: { historicalQuote: { workspaceId: workspace.id } },
      select: { partNumber: true, description: true },
    })
  ).reduce((set, l) => set.add(l.partNumber ?? l.description), new Set<string>()).size;

  if (workspace.onboardedAt && lineCount >= 300) {
    redirect("/");
  }

  const envelope = JSON.parse(workspace.capabilityEnvelope || "{}") as {
    materials?: string[];
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-plex-serif)] text-3xl text-[var(--brand)]">
          Cold start
        </h1>
        <p className="mt-2 text-[var(--ink-muted)]">
          Required before go-live: historical quotes, vendor/cost files, capability
          envelope, and margin floor. Current corpus:{" "}
          <strong>{lineCount}</strong> priced lines, <strong>{distinctItems}</strong>{" "}
          distinct items (PRD §7 minimum: ~300 lines and ≥50 items).
        </p>
      </div>

      <div className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-6 text-sm shadow-[var(--shadow)]">
        <h2 className="font-semibold">Cost files are a GREEN requirement</h2>
        <p className="mt-2 text-[var(--ink-muted)]">
          {workspace.requireCostForGreen ? (
            <>
              This workspace requires a resolvable cost record before a line can be
              GREEN. Without one, margin cannot be checked against the{" "}
              {workspace.marginFloorPct}% floor, and a line with unknown margin is
              held at AMBER rather than passed silently. Cost records loaded:{" "}
              <strong>{costCount}</strong>.
            </>
          ) : (
            <>
              This workspace allows GREEN without a cost record, so lines can be
              auto-priced with unverified margin. Cost records loaded:{" "}
              <strong>{costCount}</strong>.
            </>
          )}
        </p>
      </div>

      <form
        action={completeOnboardingAction}
        className="space-y-4 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]"
      >
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Margin floor (%)</span>
          <input
            name="marginFloorPct"
            type="number"
            defaultValue={workspace.marginFloorPct}
            className="w-full rounded border border-[var(--line)] bg-white px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Capability materials</span>
          <input
            name="materials"
            defaultValue={(envelope.materials ?? []).join(", ")}
            className="w-full rounded border border-[var(--line)] bg-white px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">
            Import history (one line per row: part|description|qty|unitPrice|material)
          </span>
          <textarea
            name="historyPaste"
            rows={8}
            placeholder="BP-999|Custom bracket|25|18.5|A36"
            className="w-full rounded border border-[var(--line)] bg-white px-3 py-2 font-mono text-sm"
          />
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
              Recommended. When no cost record resolves, margin is unknown and the
              line is held at AMBER instead of auto-priced.
            </span>
          </span>
        </label>
        <p className="text-xs text-[var(--ink-muted)]">
          Import real quote history. The demo corpus (`npm run db:seed -- --demo`) is
          synthetic and is not valid for evaluating pricing.
        </p>
        <button
          type="submit"
          className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white"
        >
          Complete onboarding
        </button>
      </form>
    </div>
  );
}
