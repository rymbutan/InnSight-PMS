-- Inventory: capacity-integrity constraints that Prisma's schema language cannot
-- express. These are the DATABASE-LEVEL backstop behind the application locking
-- in POST /api/holds. Do not drop them.
--
-- This migration is intentionally separate from the generated baseline so that
-- regenerating the baseline never clobbers it.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. One hold row per (group, night).
--
-- A booking claims one row per night it spans, sharing a groupId. Two rows for
-- the same group and night would double-count that booking against inventory —
-- which is exactly what the old duplicate-hold bug did when reservation:created
-- and reservation:confirmed both fired for one booking.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryHold_groupId_date_key"
  ON "InventoryHold" ("groupId", "date");

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. DELIBERATELY NOT a unique index on (reservationId, date).
--
-- An earlier revision of this migration created:
--
--   CREATE UNIQUE INDEX ... ON "InventoryHold" ("reservationId", "date")
--     WHERE "reservationId" IS NOT NULL AND "status" IN ('ACTIVE','COMMITTED');
--
-- It is dropped here because it breaks the most common edit in the system. A
-- date change claims the NEW range before releasing the OLD one (so capacity is
-- never briefly given away), which means both groups legitimately carry the same
-- reservationId on any overlapping night. Extending a stay by one night, or
-- shifting it by a day, would violate the index and fail with a 500.
--
-- Idempotency is instead guaranteed by the (groupId, date) index above: a hold
-- group is created exactly once, inside the locked transaction, and nothing else
-- writes hold rows.
-- ─────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS "InventoryHold_reservation_live_group_key";

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Capacity must be a sane non-negative number.
--
-- PATCH /api/room-types validated only `>= 0` in application code. This makes it
-- impossible to bypass by any other write path.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "RoomType"
  DROP CONSTRAINT IF EXISTS "RoomType_totalInventory_nonnegative";
ALTER TABLE "RoomType"
  ADD CONSTRAINT "RoomType_totalInventory_nonnegative"
  CHECK ("totalInventory" >= 0);

ALTER TABLE "InventoryHold"
  DROP CONSTRAINT IF EXISTS "InventoryHold_quantity_positive";
ALTER TABLE "InventoryHold"
  ADD CONSTRAINT "InventoryHold_quantity_positive"
  CHECK ("quantity" > 0);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Facility bookings cannot overlap for the same facility.
--
-- The application check (findFirst for a clash, outside any transaction) is the
-- same TOCTOU pattern as the old room-booking bug. btree_gist provides the `=`
-- operator class needed to mix an equality column with a range overlap test.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "FacilityBooking"
  DROP CONSTRAINT IF EXISTS "FacilityBooking_no_overlap";
ALTER TABLE "FacilityBooking"
  ADD CONSTRAINT "FacilityBooking_no_overlap"
  EXCLUDE USING gist (
    "facilityId" WITH =,
    tsrange("startAt", "endAt", '[)') WITH &&
  )
  WHERE ("status" = 'CONFIRMED');
