-- Phase 12 — Gmail notification channel + one-click approval tokens + learning transparency.
-- Additive only: new enum value, two new tables, one new nullable column.
-- Follows the hand-written style of 20260830120000_add_telegram_summary_types
-- (IF NOT EXISTS so replay converges).

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MEDIUM_RISK_APPROVAL_REQUIRED';

CREATE TABLE IF NOT EXISTS "gmail_notifications" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "incidentId" TEXT,
  "type" "NotificationType" NOT NULL DEFAULT 'INCIDENT',
  "severity" "IncidentSeverity",
  "recipient" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'SENT',
  "gmailMessageId" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "lastSentAt" TIMESTAMPTZ,
  CONSTRAINT "gmail_notifications_incidentId_fkey"
    FOREIGN KEY ("incidentId") REFERENCES "incidents"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "gmail_notifications_incidentId_type_idx"
  ON "gmail_notifications"("incidentId", "type");
CREATE INDEX IF NOT EXISTS "gmail_notifications_incidentId_idx"
  ON "gmail_notifications"("incidentId");
CREATE INDEX IF NOT EXISTS "gmail_notifications_deliveryStatus_idx"
  ON "gmail_notifications"("deliveryStatus");

CREATE TABLE IF NOT EXISTS "approval_tokens" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "approvalId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "action" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "usedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "approval_tokens_approvalId_fkey"
    FOREIGN KEY ("approvalId") REFERENCES "approvals"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "approval_tokens_approvalId_idx"
  ON "approval_tokens"("approvalId");
CREATE INDEX IF NOT EXISTS "approval_tokens_expiresAt_idx"
  ON "approval_tokens"("expiresAt");

ALTER TABLE "repair_memories" ADD COLUMN IF NOT EXISTS "rewardBreakdown" JSONB;
ALTER TABLE "repair_experiences" ADD COLUMN IF NOT EXISTS "rewardBreakdown" JSONB;
