-- Instructor-authored inspection scenarios: a room deliberately set up wrong,
-- the booking it is wrong for, and which object is wrong in which way.
--
-- Idempotent throughout: scripts/db-init.sh re-applies every non-baseline
-- migration via `prisma db execute` on EVERY container start, so a plain
-- CREATE TABLE would crash the second boot.
CREATE TABLE IF NOT EXISTS "InspectionScenario" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roomTier" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "booking" JSONB NOT NULL,
    "furniture" JSONB NOT NULL,
    "anchors" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionScenario_pkey" PRIMARY KEY ("id")
);

-- The sim queries active scenarios for one tier on every run.
CREATE INDEX IF NOT EXISTS "InspectionScenario_roomTier_active_idx"
  ON "InspectionScenario"("roomTier", "active");

-- A scenario with no name is unusable in the picker, and a blank tier would
-- never be selected by the sim.
ALTER TABLE "InspectionScenario" DROP CONSTRAINT IF EXISTS "InspectionScenario_named";
ALTER TABLE "InspectionScenario"
  ADD CONSTRAINT "InspectionScenario_named"
  CHECK (length(btrim("name")) > 0 AND length(btrim("roomTier")) > 0);
