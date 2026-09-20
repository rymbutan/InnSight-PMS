-- A priced, admin-managed catalog of add-ons, separate from
-- Reservation.specialRequests (free-text guest preference, no cost). Before
-- this existed, the wizard's "Add-ons" step doubled as the only place to
-- record a special request, with a freeform staff-typed cost for every
-- line — so "quiet room" got billed to the folio like a paid extra, and the
-- same real add-on (e.g. "Airport transfer") could be priced differently
-- reservation to reservation.
--
-- IF NOT EXISTS / ON CONFLICT throughout: scripts/db-init.sh re-applies every
-- non-baseline migration file via `prisma db execute` on EVERY container
-- start, on top of whatever `prisma migrate deploy` already did.
CREATE TABLE IF NOT EXISTS "AddOnCatalogItem" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AddOnCatalogItem_pkey" PRIMARY KEY ("code")
);

-- Starter catalog — genuinely billable extras. Prices are seed defaults;
-- admins edit them from the wizard's Add-ons step (PATCH
-- /api/settings/addon-catalog/:code) without a redeploy.
INSERT INTO "AddOnCatalogItem" ("code", "label", "priceCents", "active", "updatedAt") VALUES
    ('EXTRA_BED', 'Extra bed', 50000, true, CURRENT_TIMESTAMP),
    ('BABY_COT', 'Baby cot', 30000, true, CURRENT_TIMESTAMP),
    ('AIRPORT_TRANSFER', 'Airport transfer', 80000, true, CURRENT_TIMESTAMP),
    ('EARLY_CHECKIN', 'Early check-in', 50000, true, CURRENT_TIMESTAMP),
    ('LATE_CHECKOUT', 'Late checkout', 50000, true, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
