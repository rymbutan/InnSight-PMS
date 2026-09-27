-- A cancelled reservation's deposit refund/forfeit decision. No Folio exists
-- pre-arrival to record this against (see services/folio's redis subscriber,
-- which only creates one at check-in), so it lives on the Reservation row
-- itself.
--
-- IF NOT EXISTS: db-init.sh re-applies every non-baseline migration.sql via
-- `prisma db execute` on EVERY container start, so a plain ADD COLUMN would
-- crash the second boot.
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "depositRefundedCents" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "depositRefundedAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "depositRefundedBy" TEXT;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "depositRefundReason" TEXT;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "depositForfeitedAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "depositForfeitedBy" TEXT;
