-- Priced, admin-managed catalog of reservation add-ons (extra pillows,
-- airport transfer, late checkout…), managed from the Amenities & Facilities
-- page alongside Facility — the same "priced extra the front desk can sell"
-- shape — instead of a separate settings screen. `code` is what
-- GuestPreference (guest-service, category 'addon') keys a guest's standing
-- checklist against.
--
-- IF NOT EXISTS throughout because db-init.sh re-applies every non-baseline
-- migration.sql on EVERY container start.
CREATE TABLE IF NOT EXISTS "AddOnCatalogItem" (
  "id"         TEXT         NOT NULL,
  "code"       TEXT         NOT NULL,
  "label"      TEXT         NOT NULL,
  "priceCents" INTEGER      NOT NULL,
  "active"     BOOLEAN      NOT NULL DEFAULT true,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AddOnCatalogItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AddOnCatalogItem_code_key" ON "AddOnCatalogItem"("code");

-- Seed the 8 standardized options that already exist as a hardcoded frontend
-- list (web/src/lib/guestAddonPreferences.js) so existing guest checklists
-- keep matching codes once the frontend switches to reading this catalog.
-- Prices are placeholders — an admin sets real ones from Amenities & Facilities.
INSERT INTO "AddOnCatalogItem" ("id", "code", "label", "priceCents", "active", "updatedAt") VALUES
  (gen_random_uuid()::text, 'EXTRA_PILLOWS', 'Extra pillows', 0, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'EXTRA_TOWELS', 'Extra towels', 0, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'EXTRA_BED', 'Extra bed', 50000, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'BABY_COT', 'Baby cot', 30000, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'HYPOALLERGENIC_BEDDING', 'Hypoallergenic bedding', 0, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'AIRPORT_TRANSFER', 'Airport transfer', 80000, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'EARLY_CHECKIN', 'Early check-in', 0, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'LATE_CHECKOUT', 'Late checkout', 0, true, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
