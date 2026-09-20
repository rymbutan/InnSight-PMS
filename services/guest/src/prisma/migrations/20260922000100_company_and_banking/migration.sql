-- Company/employee details and saved banking info on a Guest profile
-- (Ms. Padilla, Lane A-07) — a corporate guest billed through an employer,
-- and a reusable bank-transfer detail so a repeat guest's deposit doesn't
-- need retyping on every reservation.
--
-- IF NOT EXISTS / ON CONFLICT throughout: scripts/db-init.sh re-applies every
-- non-baseline migration file via `prisma db execute` on EVERY container
-- start, on top of whatever `prisma migrate deploy` already did.
ALTER TABLE "Guest" ADD COLUMN IF NOT EXISTS "companyName" TEXT;
ALTER TABLE "Guest" ADD COLUMN IF NOT EXISTS "employeeName" TEXT;

CREATE TABLE IF NOT EXISTS "GuestBankAccount" (
    "id" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumberLast4" TEXT NOT NULL,
    "transferNetwork" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuestBankAccount_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GuestBankAccount_guestId_idx" ON "GuestBankAccount" ("guestId");

ALTER TABLE "GuestBankAccount" DROP CONSTRAINT IF EXISTS "GuestBankAccount_guestId_fkey";
ALTER TABLE "GuestBankAccount"
  ADD CONSTRAINT "GuestBankAccount_guestId_fkey"
  FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
