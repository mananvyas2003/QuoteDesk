-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RfqLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rfqId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "rawText" TEXT NOT NULL,
    "qty" REAL NOT NULL,
    "qtyBreaks" TEXT NOT NULL DEFAULT '[]',
    "extractedFields" TEXT NOT NULL DEFAULT '{}',
    "sourcePtr" TEXT NOT NULL DEFAULT '{}',
    "extractConf" REAL NOT NULL DEFAULT 0.5,
    "extractionBlockers" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "RfqLine_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_RfqLine" ("extractConf", "extractedFields", "id", "lineNumber", "qty", "qtyBreaks", "rawText", "rfqId", "sourcePtr") SELECT "extractConf", "extractedFields", "id", "lineNumber", "qty", "qtyBreaks", "rawText", "rfqId", "sourcePtr" FROM "RfqLine";
DROP TABLE "RfqLine";
ALTER TABLE "new_RfqLine" RENAME TO "RfqLine";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
