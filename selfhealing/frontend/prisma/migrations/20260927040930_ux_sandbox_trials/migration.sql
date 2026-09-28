-- AlterTable
ALTER TABLE "ux_events" ADD COLUMN     "dx" INTEGER,
ADD COLUMN     "dy" INTEGER,
ADD COLUMN     "targetH" INTEGER,
ADD COLUMN     "targetW" INTEGER;

-- AlterTable
ALTER TABLE "ux_suggestions" ADD COLUMN     "sandbox" JSONB;
