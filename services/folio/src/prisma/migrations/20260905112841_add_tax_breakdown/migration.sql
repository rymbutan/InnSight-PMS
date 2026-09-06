-- IDEMPOTENT BY REQUIREMENT, not by preference. db-init.sh re-applies every
-- non-baseline migration.sql with `prisma db execute` on EVERY container start
-- (it is what installs raw constraints under `db push` and what restores them
-- if a later push drops them). A plain ADD COLUMN fails on the second start
-- with "column already exists" and the service crash-loops behind an image
-- that built fine — the same trap the add_payment_intent and add_app_setting
-- migrations in this same directory document.

-- AlterTable
ALTER TABLE "FolioTransaction" ADD COLUMN IF NOT EXISTS "taxBreakdown" JSONB;
