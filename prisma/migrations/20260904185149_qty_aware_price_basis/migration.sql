-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PriceBasis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resolvedItemId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "unitPrice" REAL,
    "asOfDate" DATETIME,
    "comparableCount" INTEGER NOT NULL DEFAULT 0,
    "variance" REAL,
    "citationLabel" TEXT,
    "method" TEXT NOT NULL DEFAULT 'none',
    "qtyRequested" REAL,
    "qtyRangeMin" REAL,
    "qtyRangeMax" REAL,
    "fitSlope" REAL,
    "fitR2" REAL,
    CONSTRAINT "PriceBasis_resolvedItemId_fkey" FOREIGN KEY ("resolvedItemId") REFERENCES "ResolvedItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PriceBasis" ("asOfDate", "citationLabel", "comparableCount", "id", "resolvedItemId", "sourceId", "sourceType", "unitPrice", "variance") SELECT "asOfDate", "citationLabel", "comparableCount", "id", "resolvedItemId", "sourceId", "sourceType", "unitPrice", "variance" FROM "PriceBasis";
DROP TABLE "PriceBasis";
ALTER TABLE "new_PriceBasis" RENAME TO "PriceBasis";
CREATE UNIQUE INDEX "PriceBasis_resolvedItemId_key" ON "PriceBasis"("resolvedItemId");
CREATE TABLE "new_QuoteLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quoteId" TEXT NOT NULL,
    "resolvedItemId" TEXT,
    "priceBasisId" TEXT,
    "lineNumber" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "qty" REAL NOT NULL,
    "unitPrice" REAL,
    "confidenceState" TEXT NOT NULL,
    "clarification" TEXT,
    "leadDays" INTEGER,
    "qtyBreakPricing" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "QuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "QuoteLine_resolvedItemId_fkey" FOREIGN KEY ("resolvedItemId") REFERENCES "ResolvedItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "QuoteLine_priceBasisId_fkey" FOREIGN KEY ("priceBasisId") REFERENCES "PriceBasis" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_QuoteLine" ("clarification", "confidenceState", "description", "id", "leadDays", "lineNumber", "priceBasisId", "qty", "quoteId", "resolvedItemId", "unitPrice") SELECT "clarification", "confidenceState", "description", "id", "leadDays", "lineNumber", "priceBasisId", "qty", "quoteId", "resolvedItemId", "unitPrice" FROM "QuoteLine";
DROP TABLE "QuoteLine";
ALTER TABLE "new_QuoteLine" RENAME TO "QuoteLine";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
