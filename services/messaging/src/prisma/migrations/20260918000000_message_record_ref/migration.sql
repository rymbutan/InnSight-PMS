-- A message may point at one record — a reservation, folio or guest profile —
-- which the browser draws as a chip that opens the record in place. The type
-- and id say WHAT it points at; the label and sub are a snapshot of how to name
-- it, taken at send time, so the chip renders from the row alone and still
-- reads correctly after the record is renamed or deleted. See
-- src/lib/recordRef.js for the shape and why it is not a pasted link.
--
-- IF NOT EXISTS because db-init.sh re-applies every non-baseline migration.sql
-- on EVERY container start; a plain ADD COLUMN fails on the second start and
-- the service crash-loops behind an image that built fine.
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "refType"  TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "refId"    TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "refLabel" TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "refSub"   TEXT;
