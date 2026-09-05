import { prisma } from "./db";

type WorkspaceLike = { id: string; name: string; isDemo: boolean };

/**
 * PRD §7: "Rule: no history, no onboarding." A workspace with no priced
 * historical lines cannot resolve a price basis for anything, so every line
 * would be RED. Rendering an empty inbox instead of saying so hides a
 * misconfiguration behind what looks like a quiet day.
 *
 * The demo corpus is allowed through so the UI stays smoke-testable; it
 * banners itself as synthetic everywhere it appears.
 */
export async function assertUsableCorpus(workspace: WorkspaceLike): Promise<void> {
  if (workspace.isDemo) return;

  const lines = await prisma.historicalQuoteLine.count({
    where: { historicalQuote: { workspaceId: workspace.id } },
  });
  if (lines > 0) return;

  throw new Error(
    [
      `Workspace "${workspace.name}" has no historical priced lines.`,
      "",
      "PRD §7 — Onboarding / cold start: \"Rule: no history, no onboarding.\"",
      "Without a corpus there is no price basis, every line is RED, and the",
      "product is a worse version of the estimator. §7 puts the minimum viable",
      "corpus at ~300 priced lines and >=50 distinct items.",
      "",
      "Load a real corpus at /onboarding, or import one with the format in",
      "scripts/BACKTEST.md.",
      "",
      "For a synthetic corpus to click through (NOT valid for evaluation):",
      "",
      "    npm run db:seed -- --demo",
    ].join("\n"),
  );
}

/**
 * V1 single-tenant: always resolve the first workspace + estimator.
 *
 * `requireCorpus` defaults to true — pages that show or price RFQs must fail
 * loudly on an unusable workspace. Onboarding and settings pass false, since
 * they are how the corpus gets loaded in the first place.
 */
export async function getWorkspaceContext(opts?: { requireCorpus?: boolean }) {
  const workspace = await prisma.workspace.findFirst({
    orderBy: { createdAt: "asc" },
    include: {
      users: { where: { role: "estimator" }, take: 1 },
    },
  });
  if (!workspace) {
    throw new Error(
      [
        "No workspace found.",
        "",
        "PRD §7 — Onboarding / cold start: load a real quote corpus before go-live.",
        "",
        "For a synthetic corpus to click through (NOT valid for evaluation):",
        "",
        "    npm run db:seed -- --demo",
      ].join("\n"),
    );
  }
  const user = workspace.users[0];
  if (!user) {
    throw new Error(
      `Workspace "${workspace.name}" has no estimator user. Create one before drafting quotes.`,
    );
  }
  if (opts?.requireCorpus !== false) {
    await assertUsableCorpus(workspace);
  }
  return { workspace, user };
}
