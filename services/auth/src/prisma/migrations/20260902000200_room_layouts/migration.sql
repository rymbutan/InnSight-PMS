-- THE room layout for a tier — one truth for every browser.
--
-- Layouts used to live in each browser's localStorage, which meant two people
-- editing the same tier saw different rooms, a layout could vanish with the
-- browser profile, and nothing in the system could say which one was real.
--
-- Append-only by design: a save inserts version N+1 and never updates a row, so
-- the live layout is the highest version per tier and every earlier version
-- survives as a restorable backup.
--
-- Idempotent throughout: scripts/db-init.sh re-applies every non-baseline
-- migration on EVERY container start.

CREATE TABLE IF NOT EXISTS "RoomLayout" (
    "id"        TEXT NOT NULL,
    "roomTier"  TEXT NOT NULL,
    "version"   INTEGER NOT NULL,
    "room"      JSONB NOT NULL,
    "furniture" JSONB NOT NULL,
    "walls"     JSONB NOT NULL,
    "stations"  JSONB NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomLayout_pkey" PRIMARY KEY ("id")
);

-- Two writers cannot both claim version N for a tier; the loser retries.
CREATE UNIQUE INDEX IF NOT EXISTS "RoomLayout_roomTier_version_key"
    ON "RoomLayout"("roomTier", "version");
CREATE INDEX IF NOT EXISTS "RoomLayout_roomTier_version_idx"
    ON "RoomLayout"("roomTier", "version");
