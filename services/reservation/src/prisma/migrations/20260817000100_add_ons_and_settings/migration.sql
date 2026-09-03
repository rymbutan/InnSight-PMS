-- Reservation add-ons (Changes-to-be-made doc, item 4): a special-request line
-- item with a staff-entered cost and an admin-configurable percentage fee,
-- computed and frozen at reservation-creation time so a later fee change
-- never rewrites an existing guest's total.
--
-- IF NOT EXISTS / ON CONFLICT throughout: scripts/db-init.sh re-applies every
-- non-baseline migration file via `prisma db execute` on EVERY container
-- start, on top of whatever `prisma migrate deploy` or `prisma db push`
-- already did — a plain ADD COLUMN without IF NOT EXISTS would crash the
-- second boot.
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "addOns" JSONB;

-- Generic key/value settings store. First user: the add-on fee percentage,
-- admin-editable from the reservation wizard.
CREATE TABLE IF NOT EXISTS "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

INSERT INTO "AppSetting" ("key", "value", "updatedAt")
VALUES ('addon_fee_percent', '10', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
