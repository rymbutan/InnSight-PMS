-- Adds the `activity` dimension to TrainingResult.
--
-- Guest Services and Lost & Found runs were never persisted at all (they only
-- raised a toast), so the Training page's competency table could only ever reflect
-- room turnovers. Recording them needs a way to tell them apart from a turnover,
-- since `roomTier` is meaningless for a standalone activity.
--
-- Written idempotently: scripts/db-init.sh re-applies every non-baseline migration
-- with `prisma db execute` AFTER `migrate deploy` has already run it, so this file
-- is executed twice on every container start by design.
ALTER TABLE "TrainingResult"
  ADD COLUMN IF NOT EXISTS "activity" TEXT NOT NULL DEFAULT 'TURNOVER';

CREATE INDEX IF NOT EXISTS "TrainingResult_activity_createdAt_idx"
  ON "TrainingResult" ("activity", "createdAt");
