-- IDEMPOTENT BY REQUIREMENT, not by preference. db-init.sh re-applies every
-- non-baseline migration.sql with `prisma db execute` on EVERY container start,
-- so a plain ADD COLUMN fails on the second start with "column already exists"
-- and the service crash-loops behind an image that built fine.

-- Who a payment link was emailed to, when it was emailed at all. Null for the
-- original in-person QR flow, where nothing was sent anywhere.

-- AlterTable
ALTER TABLE "PaymentIntent" ADD COLUMN IF NOT EXISTS "sentTo" TEXT;
