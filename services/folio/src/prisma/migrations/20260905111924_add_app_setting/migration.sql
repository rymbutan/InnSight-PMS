-- IDEMPOTENT BY REQUIREMENT, not by preference. db-init.sh re-applies every
-- non-baseline migration.sql with `prisma db execute` on EVERY container start
-- (it is what installs raw constraints under `db push` and what restores them
-- if a later push drops them). The plain CREATE TABLE that `prisma migrate dev`
-- generates fails on the second start with "already exists" and the service
-- crash-loops behind an image that built fine — the same trap the
-- add_payment_intent migration in this same directory documents.

-- CreateTable
CREATE TABLE IF NOT EXISTS "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);
