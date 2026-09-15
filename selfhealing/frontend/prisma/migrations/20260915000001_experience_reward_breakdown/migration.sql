-- Phase 12 follow-up: transparent reward breakdown on RepairExperience.
-- (Split out because 20260915000000 was already applied before this column
-- was added to it; IF NOT EXISTS keeps replay convergent.)

ALTER TABLE "repair_experiences" ADD COLUMN IF NOT EXISTS "rewardBreakdown" JSONB;
