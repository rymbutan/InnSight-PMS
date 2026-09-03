-- Scenarios stop authoring the booking, gain teacher-typed fault categories, and
-- can be pinned to a specific room.
--
-- WHY THE BOOKING BECOMES NULLABLE. A scenario used to store the guest it was
-- wrong FOR, so a student could inspect room 203 against "Reyes, Maria, 2
-- adults" while the PMS three feet away showed a family of five arriving.
-- Judging a room against a booking nobody made is the one thing this exercise
-- cannot afford, so the case file now comes from the real reservation attached
-- to the room. The column stays — existing rows keep their data — but nothing
-- reads it, and new scenarios do not send one.
--
-- WHY CATEGORIES ARE DATA. Six built-in fault categories cannot describe every
-- fault a property cares about (a rat is not "cleaning equipment left behind").
-- A scenario may now declare its own, and `why` is mandatory in each: it is the
-- reason printed on the student's assessment, and a category without one marks
-- them wrong with a blank explanation.
--
-- Idempotent throughout: scripts/db-init.sh re-applies every non-baseline
-- migration via `prisma db execute` on EVERY container start, so a plain
-- CREATE TABLE or a bare ALTER would crash the second boot.

ALTER TABLE "InspectionScenario" ALTER COLUMN "booking" DROP NOT NULL;
ALTER TABLE "InspectionScenario" ADD COLUMN IF NOT EXISTS "categories" JSONB;

-- Which authored scenario a specific room hands out.
--
-- Rooms live in the inventory service and scenarios in auth, so the link lives
-- here: training owns the mapping and inventory stays unaware of it. No
-- cross-service foreign key exists, and deliberately none is added — a dangling
-- scenarioId (someone deleted the scenario) must fall back to generation rather
-- than fail a student mid-run.
--
-- roomId is the primary key: one room hands out one scenario. A room with no row
-- generates its faults, or draws from its tier's authored pool.
CREATE TABLE IF NOT EXISTS "ScenarioAssignment" (
    "roomId"     TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "assignedBy" TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScenarioAssignment_pkey" PRIMARY KEY ("roomId")
);

-- Clearing every room that pointed at a deleted scenario is a single indexed
-- delete, not a table scan.
CREATE INDEX IF NOT EXISTS "ScenarioAssignment_scenarioId_idx"
  ON "ScenarioAssignment"("scenarioId");
