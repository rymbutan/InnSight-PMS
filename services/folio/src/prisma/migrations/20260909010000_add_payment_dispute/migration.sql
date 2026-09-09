-- E-wallet refund/chargeback tracking. A claim against a GCash or Maya
-- payment gets its own case, because unlike a desk-initiated refund it can
-- arrive from the gateway itself (a chargeback), and its outcome is not
-- always known the moment it is filed. Cash and card payments keep using the
-- existing /refund route unchanged.
--
-- IDEMPOTENT BY REQUIREMENT, not by preference. db-init.sh re-applies every
-- non-baseline migration.sql with `prisma db execute` on EVERY container
-- start, so a plain CREATE TYPE / CREATE TABLE fails on the second start with
-- "already exists" and the service crash-loops behind an image that built
-- fine — the same trap every other migration in this directory documents.
--
-- CREATE TYPE has no IF NOT EXISTS in PostgreSQL, hence the DO blocks.
DO $$
BEGIN
  CREATE TYPE "PaymentDisputeType" AS ENUM ('REFUND_REQUEST', 'CHARGEBACK');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE "PaymentDisputeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'DISPUTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS "PaymentDispute" (
    "id" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "type" "PaymentDisputeType" NOT NULL,
    "status" "PaymentDisputeStatus" NOT NULL DEFAULT 'PENDING',
    "amountCents" BIGINT NOT NULL,
    "reason" TEXT,
    "filedBy" TEXT,
    "filedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "refundTxId" TEXT,

    CONSTRAINT "PaymentDispute_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PaymentDispute_folioId_idx" ON "PaymentDispute"("folioId");
CREATE INDEX IF NOT EXISTS "PaymentDispute_paymentId_idx" ON "PaymentDispute"("paymentId");
CREATE INDEX IF NOT EXISTS "PaymentDispute_status_idx" ON "PaymentDispute"("status");
