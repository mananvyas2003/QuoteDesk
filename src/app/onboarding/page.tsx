import { completeOnboardingAction } from "@/lib/actions";
import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const { workspace } = await getWorkspaceContext();
  const lineCount = await prisma.historicalQuoteLine.count({
    where: { historicalQuote: { workspaceId: workspace.id } },
  });

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
          <strong>{lineCount}</strong> priced lines (target ≥300).
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
        <p className="text-xs text-[var(--ink-muted)]">
          Seed data already includes a metal-fab corpus for Summit Metal Fab so you
          can demo without importing. Add more lines to raise GREEN coverage.
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
