-- Fault categories a teacher typed, shared by every scenario and every room.
--
-- WHY THIS TABLE EXISTS
-- Custom categories used to live in InspectionScenario.categories, a per-row JSON
-- blob. A category authored for one room therefore did not exist for any other —
-- there was no way to reuse one, which is precisely the reported bug. They are a
-- library now: authored once, offered everywhere. The six built-in categories
-- stay in code and are NOT rows here.
--
-- InspectionScenario.categories is left in place: existing rows keep their data
-- and the validator still accepts the field, so nothing already saved breaks.
--
-- Idempotent throughout: scripts/db-init.sh re-applies every non-baseline
-- migration on EVERY container start.

CREATE TABLE IF NOT EXISTS "InspectionCategory" (
    "id"        TEXT NOT NULL,
    "label"     TEXT NOT NULL,
    "why"       TEXT NOT NULL,
    "feedback"  TEXT,
    "active"    BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionCategory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "InspectionCategory_active_idx" ON "InspectionCategory"("active");
