-- Calendar visibility: the two data-level halves of "the booking saved but never
-- appeared on the board".

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. '' IS NOT A ROOM ID
--
-- The booking wizard sent assignedRoomId: '' whenever a user opened the room
-- dropdown and returned it to the default. An empty string is NOT NULL, so as
-- far as Reservation_no_double_booking is concerned every such booking held the
-- same phantom room — and the second one taken for overlapping dates was
-- refused with "that room is already booked for overlapping dates", naming a
-- room that does not exist.
--
-- It also read as "assigned" to every consumer that tests the column for
-- truthiness, while being undrawable on a calendar that needs a real room row.
--
-- Normalise the existing rows, then make the state unreachable. Ordering
-- matters: the CHECK cannot be added while violating rows are present.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE "Reservation" SET "assignedRoomId" = NULL WHERE btrim("assignedRoomId") = '';

ALTER TABLE "Reservation" DROP CONSTRAINT IF EXISTS "Reservation_room_id_not_blank";
ALTER TABLE "Reservation"
  ADD CONSTRAINT "Reservation_room_id_not_blank"
  CHECK ("assignedRoomId" IS NULL OR btrim("assignedRoomId") <> '');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. AN INDEX FOR THE CALENDAR'S DATE WINDOW
--
-- GET /api/reservations?from&to now selects bookings that OVERLAP the window
-- rather than those that START in it (see src/lib/listQuery.js). Prisma emits:
--
--   WHERE "checkIn" < $to AND "checkOut" > $from
--
-- The existing ("checkIn", "status") index only serves the first predicate, and
-- the calendar sends no status, so it degraded to a scan plus a heap fetch per
-- candidate row. This composite covers both columns, so the second predicate is
-- evaluated in the index.
--
-- NOTE ON THE ALTERNATIVE: a GiST index on tsrange("checkIn","checkOut",'[)')
-- serves range overlap far better at scale, but only for a query written AS a
-- range overlap (`&&`), which Prisma cannot express. Adopting it means moving
-- this query to $queryRaw. Worth doing when the Reservation table reaches the
-- millions of rows; a btree on two dates is the right trade before that, and an
-- index no query can use would be pure write cost.
--
-- btree_gist and the per-room GiST index for the exclusion constraint already
-- exist — see 20260729000100_no_double_booking.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Reservation_checkIn_checkOut_idx"
  ON "Reservation" ("checkIn", "checkOut");
