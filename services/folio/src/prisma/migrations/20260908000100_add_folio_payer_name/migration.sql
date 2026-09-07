-- IDEMPOTENT BY REQUIREMENT, not by preference. db-init.sh re-applies every
-- non-baseline migration.sql with `prisma db execute` on EVERY container start,
-- so a plain ADD COLUMN fails on the second start with "column already exists"
-- and the service crash-loops behind an image that built fine. Same trap the
-- add_tax_breakdown, add_payment_intent and add_app_setting migrations in this
-- directory document.

-- Who a folio bills, when that is not simply the guest whose stay it belongs to.
--
-- Set per payer when a bill is split. Nullable because every folio that already
-- exists, and every folio opened outside a split, has no distinct payer and
-- correctly falls back to the stay's guest name — so no historical folio's
-- printed document changes.
--
-- A plain string and not a guestId: a co-payer is very often not a guest in the
-- system at all (a company, an employer, a friend settling the bar tab), and
-- requiring a guest record for one would make splitting harder than doing it by
-- hand.

-- AlterTable
ALTER TABLE "Folio" ADD COLUMN IF NOT EXISTS "payerName" TEXT;
