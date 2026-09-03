-- Scenarios track the LIVE tier layout instead of snapshotting a room.
--
-- Before this, a scenario stored `furniture` (a full snapshot) and `anchors`,
-- and fromScenario() rebuilt the room as `{ ...scenario.baseLayout, furniture }`
-- — but nothing ever wrote baseLayout. Every authored scenario therefore
-- rendered with w, l, h, floor, spawn and walls all undefined: no bathroom
-- walls, and a shadow frustum sized from Math.max(undefined, undefined).
--
-- Now the room comes from getRoomPlan(roomTier) at run time and a scenario
-- stores only what is WRONG with it:
--   swaps  { "<ref>": "<modelKey>" | { model?, ry? } }  asset and facing overrides
--   added  [ { id, model|prim, pos, ry, y, size } ]      objects the teacher placed
--   tags   [ { ref, defectId|null, label } ]             what is wrong, and decoys
--
-- `furniture` and `anchors` stay NOT NULL and keep working: a row with a
-- NON-EMPTY furniture array is treated as a legacy snapshot and rendered as
-- authored, so nothing already saved breaks. New rows send [].
--
-- Idempotent: scripts/db-init.sh re-applies every non-baseline migration via
-- `prisma db execute` on EVERY container start.
ALTER TABLE "InspectionScenario" ADD COLUMN IF NOT EXISTS "swaps" JSONB;
ALTER TABLE "InspectionScenario" ADD COLUMN IF NOT EXISTS "added" JSONB;
ALTER TABLE "InspectionScenario" ADD COLUMN IF NOT EXISTS "tags"  JSONB;
