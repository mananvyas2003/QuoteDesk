-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "vertical" TEXT NOT NULL DEFAULT 'metal_fabrication',
    "marginFloorPct" REAL NOT NULL DEFAULT 25,
    "capabilityEnvelope" TEXT NOT NULL DEFAULT '{}',
    "ingestEmail" TEXT,
    "onboardedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'estimator',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Account_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HistoricalQuote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT,
    "quoteNumber" TEXT,
    "quotedAt" DATETIME NOT NULL,
    "total" REAL,
    "rawRef" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HistoricalQuote_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HistoricalQuote_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HistoricalQuoteLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "historicalQuoteId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "partNumber" TEXT,
    "material" TEXT,
    "finish" TEXT,
    "qty" REAL NOT NULL,
    "unitPrice" REAL NOT NULL,
    "sku" TEXT,
    "specHash" TEXT,
    CONSTRAINT "HistoricalQuoteLine_historicalQuoteId_fkey" FOREIGN KEY ("historicalQuoteId") REFERENCES "HistoricalQuote" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VendorPrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "sku" TEXT,
    "description" TEXT NOT NULL,
    "material" TEXT,
    "unitPrice" REAL NOT NULL,
    "asOfDate" DATETIME NOT NULL,
    "vendorName" TEXT,
    CONSTRAINT "VendorPrice_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Rfq" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline" DATETIME,
    "channel" TEXT NOT NULL DEFAULT 'upload',
    "subject" TEXT,
    "fromEmail" TEXT,
    "fromName" TEXT,
    "rawBody" TEXT,
    "rawRefs" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'ingested',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Rfq_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Rfq_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RfqLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rfqId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "rawText" TEXT NOT NULL,
    "qty" REAL NOT NULL,
    "qtyBreaks" TEXT NOT NULL DEFAULT '[]',
    "extractedFields" TEXT NOT NULL DEFAULT '{}',
    "sourcePtr" TEXT NOT NULL DEFAULT '{}',
    "extractConf" REAL NOT NULL DEFAULT 0.5,
    CONSTRAINT "RfqLine_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResolvedItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rfqLineId" TEXT NOT NULL,
    "sku" TEXT,
    "specHash" TEXT,
    "matchType" TEXT NOT NULL,
    "matchScore" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "ResolvedItem_rfqLineId_fkey" FOREIGN KEY ("rfqLineId") REFERENCES "RfqLine" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PriceBasis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resolvedItemId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "unitPrice" REAL,
    "asOfDate" DATETIME,
    "comparableCount" INTEGER NOT NULL DEFAULT 0,
    "variance" REAL,
    "citationLabel" TEXT,
    CONSTRAINT "PriceBasis_resolvedItemId_fkey" FOREIGN KEY ("resolvedItemId") REFERENCES "ResolvedItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rfqId" TEXT NOT NULL,
    "answerType" TEXT NOT NULL,
    "sentAt" DATETIME,
    "total" REAL,
    "marginPct" REAL,
    "declineReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Quote_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QuoteLine" (
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
    CONSTRAINT "QuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "QuoteLine_resolvedItemId_fkey" FOREIGN KEY ("resolvedItemId") REFERENCES "ResolvedItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "QuoteLine_priceBasisId_fkey" FOREIGN KEY ("priceBasisId") REFERENCES "PriceBasis" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Assumption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quoteLineId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "confirmedBy" TEXT,
    "confirmedAt" DATETIME,
    CONSTRAINT "Assumption_quoteLineId_fkey" FOREIGN KEY ("quoteLineId") REFERENCES "QuoteLine" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Assumption_confirmedBy_fkey" FOREIGN KEY ("confirmedBy") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quoteLineId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "reasonCode" TEXT,
    "userId" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EditEvent_quoteLineId_fkey" FOREIGN KEY ("quoteLineId") REFERENCES "QuoteLine" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Outcome" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quoteId" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "competitorPrice" REAL,
    "marginRealized" REAL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Outcome_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ResolvedItem_rfqLineId_key" ON "ResolvedItem"("rfqLineId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBasis_resolvedItemId_key" ON "PriceBasis"("resolvedItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_rfqId_key" ON "Quote"("rfqId");

-- CreateIndex
CREATE UNIQUE INDEX "Assumption_quoteLineId_key" ON "Assumption"("quoteLineId");

-- CreateIndex
CREATE UNIQUE INDEX "Outcome_quoteId_key" ON "Outcome"("quoteId");

