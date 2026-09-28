-- CreateTable
CREATE TABLE "jira_approvals" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "issueKey" TEXT,
    "issueUrl" TEXT,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "lastStatus" TEXT,
    "decidedBy" TEXT,
    "outcome" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "jira_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "jira_approvals_approvalId_key" ON "jira_approvals"("approvalId");

-- CreateIndex
CREATE INDEX "jira_approvals_state_idx" ON "jira_approvals"("state");

-- CreateIndex
CREATE INDEX "jira_approvals_issueKey_idx" ON "jira_approvals"("issueKey");
