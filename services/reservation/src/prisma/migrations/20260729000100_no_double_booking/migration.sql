-- Reservation: double-booking integrity.
--
-- DATABASE-LEVEL backstop behind the two-phase hold in
-- src/routes/reservation.routes.js. The hold in the inventory service enforces
-- ROOM-TYPE capacity ("are there any King rooms left?"). This constraint enforces
-- PHYSICAL-ROOM exclusivity ("is room 412 already promised to someone?"), which
-- inventory cannot see because assignedRoomId lives in this database.
--
-- Kept separate from the generated baseline so regenerating it cannot drop this.

-- btree_gist supplies the `=` operator class needed to combine an equality column
-- with a range-overlap test in one exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ─────────────────────────────────────────────────────────────────────────────
-- No two live reservations may hold the same physical room over overlapping
-- dates.
--
-- '[)' is a half-open range: a reservation checking out on the 5th and another
-- checking in on the 5th do NOT overlap, which is exactly how hotel nights work.
--
-- Excluded from the constraint:
--   - rows with no room assigned yet (assignment happens later for many bookings)
--   - CANCELLED / NO_SHOW / CHECKED_OUT, which no longer occupy anything
--
-- This is the last line of defence. It should never fire in normal operation — if
-- it does, a write path bypassed the hold flow and that is the real bug.
--
-- If creation fails, the database already contains overlapping rows from before
-- the fix. Find them with:
--
--   SELECT a.id, b.id, a."assignedRoomId", a."checkIn", a."checkOut"
--   FROM "Reservation" a
--   JOIN "Reservation" b
--     ON a."assignedRoomId" = b."assignedRoomId"
--    AND a.id < b.id
--    AND tsrange(a."checkIn", a."checkOut", '[)')
--     && tsrange(b."checkIn", b."checkOut", '[)')
--   WHERE a."assignedRoomId" IS NOT NULL
--     AND a.status NOT IN ('CANCELLED', 'NO_SHOW', 'CHECKED_OUT')
--     AND b.status NOT IN ('CANCELLED', 'NO_SHOW', 'CHECKED_OUT');
--
-- ...then reassign or cancel one side of each pair before re-running.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "Reservation"
  DROP CONSTRAINT IF EXISTS "Reservation_no_double_booking";
ALTER TABLE "Reservation"
  ADD CONSTRAINT "Reservation_no_double_booking"
  EXCLUDE USING gist (
    "assignedRoomId" WITH =,
    tsrange("checkIn", "checkOut", '[)') WITH &&
  )
  WHERE (
    "assignedRoomId" IS NOT NULL
    AND "status" NOT IN ('CANCELLED', 'NO_SHOW', 'CHECKED_OUT')
  );

-- A stay must last at least one night.
ALTER TABLE "Reservation" DROP CONSTRAINT IF EXISTS "Reservation_checkout_after_checkin";
ALTER TABLE "Reservation"
  ADD CONSTRAINT "Reservation_checkout_after_checkin"
  CHECK ("checkOut" > "checkIn");

-- Occupancy and money are never negative.
ALTER TABLE "Reservation" DROP CONSTRAINT IF EXISTS "Reservation_sane_counts";
ALTER TABLE "Reservation"
  ADD CONSTRAINT "Reservation_sane_counts"
  CHECK (
    "adults" >= 1
    AND "children" >= 0
    AND "nights" >= 1
    AND "totalEstimateCents" >= 0
    AND "depositCents" >= 0
  );
