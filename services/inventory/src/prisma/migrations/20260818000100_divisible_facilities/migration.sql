-- Divisible spaces (Changes-to-be-made doc, item 2): a grand function hall that
-- can be sold whole or split into smaller meeting rooms.
--
-- Every statement is idempotent: scripts/db-init.sh re-applies this file via
-- `prisma db execute` on EVERY container start, on top of whatever
-- `migrate deploy` / `db push` already did.

-- ── Parent/child relation between facilities ────────────────────────────────
ALTER TABLE "Facility" ADD COLUMN IF NOT EXISTS "parentCode" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Facility_parentCode_fkey'
  ) THEN
    ALTER TABLE "Facility"
      ADD CONSTRAINT "Facility_parentCode_fkey"
      FOREIGN KEY ("parentCode") REFERENCES "Facility"("code")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- A space cannot be its own subdivision.
ALTER TABLE "Facility" DROP CONSTRAINT IF EXISTS "Facility_not_own_parent";
ALTER TABLE "Facility"
  ADD CONSTRAINT "Facility_not_own_parent"
  CHECK ("parentCode" IS NULL OR "parentCode" <> "code");

-- ── Per-leaf slot locks ─────────────────────────────────────────────────────
-- One row per physical space a booking occupies. Booking the whole hall writes
-- one lock per section; booking a section writes one lock for that section.
CREATE TABLE IF NOT EXISTS "FacilitySlotLock" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacilitySlotLock_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FacilitySlotLock_facilityId_startAt_endAt_idx"
  ON "FacilitySlotLock"("facilityId", "startAt", "endAt");
CREATE INDEX IF NOT EXISTS "FacilitySlotLock_bookingId_idx"
  ON "FacilitySlotLock"("bookingId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FacilitySlotLock_bookingId_fkey'
  ) THEN
    ALTER TABLE "FacilitySlotLock"
      ADD CONSTRAINT "FacilitySlotLock_bookingId_fkey"
      FOREIGN KEY ("bookingId") REFERENCES "FacilityBooking"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- btree_gist supplies the `=` operator class needed to combine an equality
-- column with a range-overlap test in one exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE BACKSTOP. No two live bookings may claim the same physical space over
-- overlapping time.
--
-- '[)' is half-open: a function ending at 14:00 and another starting at 14:00
-- do NOT overlap, which is how back-to-back bookings actually work.
--
-- Because a booking is decomposed into one lock per LEAF space, this single
-- constraint expresses the whole rule:
--   • whole hall vs. section A → both hold a lock on A       → rejected
--   • section A  vs. section A → both hold a lock on A       → rejected
--   • section A  vs. section B → locks on A and B, disjoint  → allowed
-- A constraint on FacilityBooking.facilityId could not express that, because
-- siblings must not exclude one another.
--
-- The application also checks this (POST /api/facility-bookings) and returns a
-- friendly 409. This is the last line of defence against two clerks booking
-- simultaneously; if it ever fires, a write path skipped the lock flow.
--
-- If creation fails, overlapping locks already exist. Find them with:
--
--   SELECT a."bookingId", b."bookingId", a."facilityId", a."startAt", a."endAt"
--   FROM "FacilitySlotLock" a
--   JOIN "FacilitySlotLock" b
--     ON a."facilityId" = b."facilityId"
--    AND a.id < b.id
--    AND tsrange(a."startAt", a."endAt", '[)')
--     && tsrange(b."startAt", b."endAt", '[)');
--
-- ...then cancel one side of each pair before re-running.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "FacilitySlotLock" DROP CONSTRAINT IF EXISTS "FacilitySlotLock_no_double_booking";
ALTER TABLE "FacilitySlotLock"
  ADD CONSTRAINT "FacilitySlotLock_no_double_booking"
  EXCLUDE USING gist (
    "facilityId" WITH =,
    tsrange("startAt", "endAt", '[)') WITH &&
  );

-- A slot must last a positive amount of time.
ALTER TABLE "FacilitySlotLock" DROP CONSTRAINT IF EXISTS "FacilitySlotLock_end_after_start";
ALTER TABLE "FacilitySlotLock"
  ADD CONSTRAINT "FacilitySlotLock_end_after_start"
  CHECK ("endAt" > "startAt");

-- ── Seed the hall's sections + the new amenity SKUs ─────────────────────────
-- ON CONFLICT DO NOTHING so re-running never overwrites prices an admin has
-- since edited in the UI.
INSERT INTO "Facility" ("id","code","name","category","pricingModel","priceCents","unit","capacity","reservable","active","description","parentCode","createdAt","updatedAt")
VALUES
  (gen_random_uuid()::text,'HALL_A','Function Hall — Section A','EVENT_HALL','PER_HOUR',60000,'per hour',40,true,true,'One third of the Grand Function Hall, divided by air wall.','HALL',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'HALL_B','Function Hall — Section B','EVENT_HALL','PER_HOUR',60000,'per hour',40,true,true,'One third of the Grand Function Hall, divided by air wall.','HALL',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'HALL_C','Function Hall — Section C','EVENT_HALL','PER_HOUR',60000,'per hour',40,true,true,'One third of the Grand Function Hall, divided by air wall.','HALL',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'LDY_POLO','Laundry — Polo','LAUNDRY','PER_USE',20000,'per piece',NULL,false,true,'Wash, dry and press, per polo shirt.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'LDY_LONGSLEEVE','Laundry — Long-sleeve shirt','LAUNDRY','PER_USE',15000,'per piece',NULL,false,true,'Wash, dry and press, per long-sleeve shirt.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'LDY_TROUSERS','Laundry — Trousers','LAUNDRY','PER_USE',18000,'per piece',NULL,false,true,'Wash, dry and press, per pair of trousers.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'LDY_DRESS','Laundry — Dress','LAUNDRY','PER_USE',25000,'per piece',NULL,false,true,'Dry clean and press, per dress.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'LDY_BEDSHEET','Laundry — Bed sheet','LAUNDRY','PER_USE',22000,'per piece',NULL,false,true,'Wash and press, per bed sheet.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'VALET','Valet Parking','PARKING','PER_DAY',15000,'per day',NULL,false,true,'Attended valet parking, per calendar day.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'MASSAGE_60','Massage — 60 minutes','SPA','PER_USE',120000,'per session',NULL,false,true,'Sixty-minute full-body massage with a licensed therapist.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'MASSAGE_90','Massage — 90 minutes','SPA','PER_USE',170000,'per session',NULL,false,true,'Ninety-minute full-body massage with a licensed therapist.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Retire the per-load laundry SKU in favour of the per-piece catalogue above.
-- Deactivated, NOT deleted: historical FolioTransaction rows carry
-- chargeCode 'LAUNDRY' and would lose their label.
UPDATE "Facility" SET "active" = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'LAUNDRY' AND "active" = true;

-- Narrow the old combined spa SKU to facility access now that massages are
-- their own services.
UPDATE "Facility"
SET "name" = 'Spa Access', "description" = 'Sauna, steam room and relaxation lounge. Massages are booked separately.'
WHERE "code" = 'SPA' AND "name" = 'Spa & Massage';
