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
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "onboardedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Workspace" ("capabilityEnvelope", "createdAt", "id", "ingestEmail", "marginFloorPct", "name", "onboardedAt", "requireCostForGreen", "updatedAt", "vertical") SELECT "capabilityEnvelope", "createdAt", "id", "ingestEmail", "marginFloorPct", "name", "onboardedAt", "requireCostForGreen", "updatedAt", "vertical" FROM "Workspace";
DROP TABLE "Workspace";
ALTER TABLE "new_Workspace" RENAME TO "Workspace";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
