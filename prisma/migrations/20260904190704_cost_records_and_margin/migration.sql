-- AlterTable
ALTER TABLE "QuoteLine" ADD COLUMN "marginPct" REAL;

-- CreateTable
CREATE TABLE "CostRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "specHash" TEXT,
    "sku" TEXT,
    "unitCost" REAL NOT NULL,
    "asOfDate" DATETIME NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CostRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "vertical" TEXT NOT NULL DEFAULT 'metal_fabrication',
    "marginFloorPct" REAL NOT NULL DEFAULT 25,
    "requireCostForGreen" BOOLEAN NOT NULL DEFAULT true,
    "capabilityEnvelope" TEXT NOT NULL DEFAULT '{}',
    "ingestEmail" TEXT,
    "onboardedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Workspace" ("capabilityEnvelope", "createdAt", "id", "ingestEmail", "marginFloorPct", "name", "onboardedAt", "updatedAt", "vertical") SELECT "capabilityEnvelope", "createdAt", "id", "ingestEmail", "marginFloorPct", "name", "onboardedAt", "updatedAt", "vertical" FROM "Workspace";
DROP TABLE "Workspace";
ALTER TABLE "new_Workspace" RENAME TO "Workspace";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CostRecord_workspaceId_sku_idx" ON "CostRecord"("workspaceId", "sku");

-- CreateIndex
CREATE INDEX "CostRecord_workspaceId_specHash_idx" ON "CostRecord"("workspaceId", "specHash");
