-- A record of every call the front desk places to housekeeping.
--
-- WHY THIS TABLE DID NOT EXIST
-- ----------------------------
-- The call was pure Redis pub/sub: POST published `housekeeping:call_placed`,
-- the answer published `housekeeping:call_answered`, and nothing was ever
-- written down ("No lookup of the original call: it was never stored" is still
-- in the answer route). That is fine for making a handset ring and useless for
-- everything after: a housekeeper coming on shift could not see what had been
-- asked for while they were away, nobody could tell an answered call from one
-- that rang out, and a supervisor had no way to ask how long calls were taking
-- to pick up. The housekeeping dashboard needs all three.
--
-- `accepted` is NULL until answered, which is the state that matters most on
-- the dashboard: a call nobody has picked up yet.
--
-- IF NOT EXISTS throughout because db-init.sh re-applies every non-baseline
-- migration.sql on EVERY container start.
CREATE TABLE IF NOT EXISTS "HousekeepingCall" (
  "id"             TEXT         NOT NULL,
  "roomId"         TEXT         NOT NULL,
  "roomNumber"     TEXT         NOT NULL,
  "reason"         TEXT         NOT NULL,
  "note"           TEXT,
  "callerId"       TEXT,
  "callerName"     TEXT,
  "targetUserId"   TEXT,
  "targetName"     TEXT,
  "placedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answeredAt"     TIMESTAMP(3),
  "answeredById"   TEXT,
  "answeredByName" TEXT,
  "accepted"       BOOLEAN,
  CONSTRAINT "HousekeepingCall_pkey" PRIMARY KEY ("id")
);

-- The log is always read newest-first, either for everyone or for one
-- housekeeper's own handset.
CREATE INDEX IF NOT EXISTS "HousekeepingCall_placedAt_idx" ON "HousekeepingCall" ("placedAt");
CREATE INDEX IF NOT EXISTS "HousekeepingCall_targetUserId_placedAt_idx" ON "HousekeepingCall" ("targetUserId", "placedAt");
