-- Add-on / special-request charge code (Changes-to-be-made doc, item 4), so a
-- reservation's add-ons can post as a normal folio CHARGE alongside room and
-- other revenue. seed.js will not reach an already-seeded database (it
-- no-ops once ChargeCode has any rows — see src/seed.js), so this is
-- inserted here instead, and re-applied idempotently by db-init.sh on every
-- container start.
INSERT INTO "ChargeCode" ("code", "name", "category", "glAccount", "taxable", "createdAt")
VALUES ('AO', 'Add-on / Special Request', 'SERVICE', '4220', true, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
