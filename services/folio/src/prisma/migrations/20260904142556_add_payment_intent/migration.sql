-- Simulated QR wallet payments.
--
-- A PaymentIntent is a pending payment addressed by a QR code: the front desk
-- generates one, the guest scans it, and confirming posts a real Payment onto the
-- folio. Nothing here touches real payment rails — this is a teaching system, and
-- a simulated e-wallet is exactly as valid as the simulated card payments the
-- system already takes.
--
-- IDEMPOTENT BY REQUIREMENT, not by preference. db-init.sh re-applies every
-- non-baseline migration.sql with `prisma db execute` on EVERY container start
-- (step 2 there — it is what installs raw constraints under `db push` and what
-- restores them if a later push drops them). The plain CREATE TYPE / CREATE TABLE
-- that `prisma migrate dev` generates fails on the second start with "already
-- exists", and the service crash-loops behind an image that built fine. That
-- exact failure took out the audit service earlier in this branch.
--
-- CREATE TYPE has no IF NOT EXISTS in PostgreSQL, hence the DO block.
DO $$
BEGIN
  CREATE TYPE "PaymentIntentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS "PaymentIntent" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'QR_WALLET',
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- The token is the only credential on an unauthenticated confirm endpoint, so the
-- unique index is a correctness constraint, not just a lookup optimisation.
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentIntent_token_key" ON "PaymentIntent"("token");

CREATE INDEX IF NOT EXISTS "PaymentIntent_folioId_status_idx" ON "PaymentIntent"("folioId", "status");
