-- AlterTable
ALTER TABLE "ux_suggestions" ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "uxId" TEXT;

-- CreateTable
CREATE TABLE "ux_events" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "uxId" TEXT,
    "path" TEXT NOT NULL,
    "x" INTEGER,
    "y" INTEGER,
    "viewportW" INTEGER,
    "viewportH" INTEGER,
    "side" TEXT,
    "msSinceLoad" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ux_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ux_events_uxId_createdAt_idx" ON "ux_events"("uxId", "createdAt");

-- CreateIndex
CREATE INDEX "ux_events_createdAt_idx" ON "ux_events"("createdAt");

-- CreateIndex
CREATE INDEX "ux_events_sessionId_idx" ON "ux_events"("sessionId");

-- CreateIndex
CREATE INDEX "ux_suggestions_uxId_idx" ON "ux_suggestions"("uxId");
