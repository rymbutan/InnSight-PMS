-- IDEMPOTENT BY REQUIREMENT, not by preference. db-init.sh re-applies every
-- non-baseline migration.sql with `prisma db execute` on EVERY container
-- start, so a plain ADD COLUMN / CREATE TABLE / ADD CONSTRAINT fails on the
-- second start with "already exists" and the service crash-loops behind an
-- image that built fine — the same trap every other migration in this
-- directory documents. ADD CONSTRAINT has no IF NOT EXISTS in PostgreSQL,
-- hence the DO block around it.

-- AlterTable
ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "bankName" TEXT,
  ADD COLUMN IF NOT EXISTS "cardholderName" TEXT,
  ADD COLUMN IF NOT EXISTS "senderName" TEXT,
  ADD COLUMN IF NOT EXISTS "transferNetwork" TEXT,
  ADD COLUMN IF NOT EXISTS "transferredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PaymentDocument" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedBy" TEXT,

    CONSTRAINT "PaymentDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentDocument_paymentId_key" ON "PaymentDocument"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentDocument_objectKey_key" ON "PaymentDocument"("objectKey");

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "PaymentDocument" ADD CONSTRAINT "PaymentDocument_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
