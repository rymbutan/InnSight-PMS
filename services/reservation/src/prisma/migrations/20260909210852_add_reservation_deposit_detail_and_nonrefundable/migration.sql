-- Per-method deposit detail (mirrors Folio's own Payment record) plus the
-- non-refundable/promo-rate flag used by the Terms & Conditions' cancellation
-- tiers.
--
-- IF NOT EXISTS: db-init.sh re-applies every non-baseline migration.sql via
-- `prisma db execute` on EVERY container start, so a plain ADD COLUMN would
-- crash the second boot.
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "depositCardMasked" TEXT;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "depositCardholderName" TEXT;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "depositBankName" TEXT;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "depositTransferNetwork" TEXT;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "depositSenderName" TEXT;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "depositGatewayRef" TEXT;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "depositTransferredAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "depositFeeCents" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "isNonRefundable" BOOLEAN NOT NULL DEFAULT false;
