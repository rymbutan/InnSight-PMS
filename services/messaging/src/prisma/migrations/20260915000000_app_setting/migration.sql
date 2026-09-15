-- Key/value settings for the messaging service. Introduced for the message
-- retention policy (Settings -> Messaging -> Message Retention), which has to be
-- readable on the hot path of every contacts/thread/unread poll and is acted on
-- by a purge job that deletes rows in THIS database — so it belongs here rather
-- than in the reservation service's AppSetting table with the theme and taxes.
--
-- IF NOT EXISTS because db-init.sh re-applies every non-baseline migration.sql
-- on EVERY container start; a plain CREATE TABLE fails on the second start and
-- the service crash-loops behind an image that built fine.
CREATE TABLE IF NOT EXISTS "AppSetting" (
  "key"       TEXT         NOT NULL,
  "value"     TEXT         NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);
