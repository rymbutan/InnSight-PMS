-- IDEMPOTENT BY REQUIREMENT, not by preference. db-init.sh re-applies every
-- non-baseline migration.sql with `prisma db execute` on EVERY container start,
-- so a plain ADD COLUMN fails on the second start with "column already exists"
-- and the service crash-loops behind an image that built fine. Same trap the
-- add_tax_breakdown, add_payment_intent and add_app_setting migrations in this
-- directory document.

-- The credential behind the folio's QR code. Nullable because every folio that
-- already exists, and every folio nobody has printed since this shipped, has
-- never needed one — it is generated lazily on first print, not backfilled here.

-- AlterTable
ALTER TABLE "Folio" ADD COLUMN IF NOT EXISTS "publicToken" TEXT;

-- The only credential on an unauthenticated read endpoint, so this unique index
-- is a correctness constraint, not just a lookup optimisation.
CREATE UNIQUE INDEX IF NOT EXISTS "Folio_publicToken_key" ON "Folio"("publicToken");
