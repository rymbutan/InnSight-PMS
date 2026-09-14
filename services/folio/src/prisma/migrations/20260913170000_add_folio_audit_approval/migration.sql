-- Night-audit sign-off on a folio, required before the desk may check the guest out.
--
-- Nullable and with no backfill on purpose. Every folio that already exists is
-- left UNAPPROVED, which is the safe direction: the alternative — defaulting
-- existing rows to approved so nothing in flight is interrupted — would silently
-- wave through exactly the folios nobody has checked.
--
-- IF NOT EXISTS because db-init.sh re-applies every non-baseline migration on
-- each container start by design.
ALTER TABLE "Folio" ADD COLUMN IF NOT EXISTS "auditApprovedAt" TIMESTAMP(3);
ALTER TABLE "Folio" ADD COLUMN IF NOT EXISTS "auditApprovedBy" TEXT;

-- The checkout guard asks "is this stay's folio approved" on every check-out, so
-- the lookup is on the hot path for the desk.
CREATE INDEX IF NOT EXISTS "Folio_stayId_auditApprovedAt_idx" ON "Folio" ("stayId", "auditApprovedAt");
