-- Walk-ins have no backing Reservation, so there was nowhere to record the
-- nightly rate the folio needs to charge for the stay, or the party size the
-- rest of the app (arrivals, calendar) already shows for reserved stays.

ALTER TABLE "Stay" ADD COLUMN IF NOT EXISTS "nightlyRateCents" INTEGER;
ALTER TABLE "Stay" ADD COLUMN IF NOT EXISTS "adults" INTEGER;
ALTER TABLE "Stay" ADD COLUMN IF NOT EXISTS "children" INTEGER;

ALTER TABLE "Stay" DROP CONSTRAINT IF EXISTS "Stay_nightlyRateCents_nonnegative";
ALTER TABLE "Stay"
  ADD CONSTRAINT "Stay_nightlyRateCents_nonnegative"
  CHECK ("nightlyRateCents" IS NULL OR "nightlyRateCents" >= 0);

ALTER TABLE "Stay" DROP CONSTRAINT IF EXISTS "Stay_occupancy_nonnegative";
ALTER TABLE "Stay"
  ADD CONSTRAINT "Stay_occupancy_nonnegative"
  CHECK (("adults" IS NULL OR "adults" >= 0) AND ("children" IS NULL OR "children" >= 0));
