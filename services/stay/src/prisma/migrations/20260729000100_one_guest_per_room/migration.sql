-- Stay: physical-occupancy integrity.
--
-- DATABASE-LEVEL backstop behind validateRoomAssignment() in
-- src/routes/stay.routes.js. The application check reads inventory over HTTP and
-- then queries this table — correct, but it is still a read-then-write, so under
-- genuinely simultaneous check-ins only the index below is authoritative.
--
-- Kept separate from the generated baseline so regenerating that baseline cannot
-- silently drop this.

-- ─────────────────────────────────────────────────────────────────────────────
-- One in-house guest per physical room.
--
-- Partial unique index: only IN_HOUSE stays with a room assigned participate.
-- DEPARTED / NO_SHOW / PRE_ARRIVAL rows are excluded, so the same room can be
-- reused by later stays and historical rows are untouched.
--
-- Prisma cannot express a partial unique index, which is why this is raw SQL. Do
-- not remove it and do not let `prisma db push` manage this table without it.
--
-- If this fails to create, the database ALREADY CONTAINS double-occupied rooms
-- from before the fix. Find them with:
--
--   SELECT "assignedRoomId", count(*), array_agg(id)
--   FROM "Stay"
--   WHERE status = 'IN_HOUSE' AND "assignedRoomId" IS NOT NULL
--   GROUP BY "assignedRoomId" HAVING count(*) > 1;
--
-- ...then resolve each duplicate (check one out, or move it) before re-running.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "Stay_one_in_house_per_room_key"
  ON "Stay" ("assignedRoomId")
  WHERE "status" = 'IN_HOUSE' AND "assignedRoomId" IS NOT NULL;

-- Deposits and key-card counts are never negative.
ALTER TABLE "Stay" DROP CONSTRAINT IF EXISTS "Stay_depositAmount_nonnegative";
ALTER TABLE "Stay"
  ADD CONSTRAINT "Stay_depositAmount_nonnegative"
  CHECK ("depositAmount" >= 0 AND "keyCardsIssued" >= 0);

-- A checkout cannot precede its check-in.
ALTER TABLE "Stay" DROP CONSTRAINT IF EXISTS "Stay_checkout_after_checkin";
ALTER TABLE "Stay"
  ADD CONSTRAINT "Stay_checkout_after_checkin"
  CHECK (
    "actualCheckOutAt" IS NULL
    OR "actualCheckInAt" IS NULL
    OR "actualCheckOutAt" >= "actualCheckInAt"
  );
