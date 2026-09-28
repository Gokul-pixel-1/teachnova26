-- AlterEnum
ALTER TYPE "AgentName" ADD VALUE 'ANALYZER';

-- AlterEnum
ALTER TYPE "IncidentStatus" ADD VALUE 'VALIDATING';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'UX_SUGGESTION_APPROVAL_REQUIRED';
ALTER TYPE "NotificationType" ADD VALUE 'UX_SUGGESTION_APPLIED';
ALTER TYPE "NotificationType" ADD VALUE 'UX_SUGGESTION_REJECTED';

-- DropIndex
DROP INDEX "telegram_notifications_incidentId_type_key";

-- AlterTable
ALTER TABLE "approval_tokens" ALTER COLUMN "expiresAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "usedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "approvals" ALTER COLUMN "expiresAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "statusUpdatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "gmail_notifications" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "lastSentAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "log_events" ADD COLUMN     "errorName" TEXT,
ADD COLUMN     "sourceFile" TEXT,
ADD COLUMN     "sourceLine" INTEGER,
ADD COLUMN     "stackTrace" TEXT;

-- AlterTable
ALTER TABLE "patch_records" ADD COLUMN     "appliedSha256" TEXT,
ADD COLUMN     "originalSha256" TEXT,
ADD COLUMN     "restoredContent" TEXT,
ADD COLUMN     "restoredSha256" TEXT,
ALTER COLUMN "appliedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "rolledBackAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "validatedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "repair_attempts" ALTER COLUMN "startedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "completedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "repair_experiences" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "repair_memories" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "telegram_notifications" ALTER COLUMN "lastSentAt" SET DATA TYPE TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ux_suggestions" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFTED',
    "component" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "summary" TEXT,
    "line" INTEGER,
    "function" TEXT,
    "currentCode" TEXT NOT NULL,
    "proposedCode" TEXT NOT NULL,
    "originalContent" TEXT,
    "appliedContent" TEXT,
    "restoredContent" TEXT,
    "originalSha256" TEXT,
    "appliedSha256" TEXT,
    "restoredSha256" TEXT,
    "validationResult" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),

    CONSTRAINT "ux_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ux_approvals" (
    "id" TEXT NOT NULL,
    "uxSuggestionId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "operator" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "statusUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ux_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ux_approval_tokens" (
    "id" TEXT NOT NULL,
    "uxApprovalId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ux_approval_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_suggestions_ref_key" ON "ux_suggestions"("ref");

-- CreateIndex
CREATE INDEX "ux_suggestions_status_idx" ON "ux_suggestions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ux_approvals_approvalId_key" ON "ux_approvals"("approvalId");

-- CreateIndex
CREATE INDEX "ux_approvals_uxSuggestionId_idx" ON "ux_approvals"("uxSuggestionId");

-- CreateIndex
CREATE INDEX "ux_approvals_approvalId_idx" ON "ux_approvals"("approvalId");

-- CreateIndex
CREATE INDEX "ux_approvals_status_idx" ON "ux_approvals"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ux_approval_tokens_tokenHash_key" ON "ux_approval_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "ux_approval_tokens_uxApprovalId_idx" ON "ux_approval_tokens"("uxApprovalId");

-- CreateIndex
CREATE INDEX "ux_approval_tokens_expiresAt_idx" ON "ux_approval_tokens"("expiresAt");

-- CreateIndex
CREATE INDEX "approvals_approvalId_idx" ON "approvals"("approvalId");

-- CreateIndex
CREATE INDEX "repair_attempts_attemptId_idx" ON "repair_attempts"("attemptId");

-- CreateIndex
CREATE INDEX "telegram_notifications_incidentId_type_idx" ON "telegram_notifications"("incidentId", "type");

-- AddForeignKey
ALTER TABLE "ux_approvals" ADD CONSTRAINT "ux_approvals_uxSuggestionId_fkey" FOREIGN KEY ("uxSuggestionId") REFERENCES "ux_suggestions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ux_approval_tokens" ADD CONSTRAINT "ux_approval_tokens_uxApprovalId_fkey" FOREIGN KEY ("uxApprovalId") REFERENCES "ux_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
