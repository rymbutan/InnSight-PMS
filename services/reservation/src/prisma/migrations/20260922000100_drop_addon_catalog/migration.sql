-- Reverts the previous migration (20260921000100_addon_catalog). Pricing
-- add-ons turned out to be the wrong direction: an add-on is a standardized
-- guest PREFERENCE (extra pillows, extra towels, ...) tracked on the guest's
-- own profile (services/guest's GuestPreference — already generic enough to
-- hold it, no schema change needed there), not a per-booking, priced line
-- item. Nothing references this table any more.
DROP TABLE IF EXISTS "AddOnCatalogItem";
