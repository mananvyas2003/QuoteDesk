import { prisma } from "./db";

/** V1 single-tenant: always resolve the seeded / first workspace + estimator. */
export async function getWorkspaceContext() {
  const workspace = await prisma.workspace.findFirst({
    orderBy: { createdAt: "asc" },
    include: {
      users: { where: { role: "estimator" }, take: 1 },
    },
  });
  if (!workspace) {
    throw new Error("No workspace found. Run: npm run db:seed");
  }
  const user = workspace.users[0];
  if (!user) {
    throw new Error("No estimator user found. Run: npm run db:seed");
  }
  return { workspace, user };
}
