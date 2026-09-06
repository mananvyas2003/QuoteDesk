-- CreateTable
CREATE TABLE "InboundEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "toEmail" TEXT,
    "subject" TEXT,
    "textBody" TEXT,
    "htmlBody" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attachments" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'received',
    "classification" TEXT,
    "rfqId" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InboundEmail_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InboundEmail_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "linkPath" TEXT,
    "readAt" DATETIME,
    "emailStatus" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmail_messageId_key" ON "InboundEmail"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmail_rfqId_key" ON "InboundEmail"("rfqId");

-- CreateIndex
CREATE INDEX "InboundEmail_workspaceId_receivedAt_idx" ON "InboundEmail"("workspaceId", "receivedAt");

-- CreateIndex
CREATE INDEX "InboundEmail_workspaceId_status_idx" ON "InboundEmail"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Notification_workspaceId_readAt_idx" ON "Notification"("workspaceId", "readAt");
