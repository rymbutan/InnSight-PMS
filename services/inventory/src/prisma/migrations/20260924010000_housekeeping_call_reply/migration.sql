-- A canned quick-reply picked at answer time (see web/src/components/IncomingCall.jsx),
-- e.g. "Sure, I'll look into it." or "Sorry, I'm busy — can you assign it to
-- someone else?" — null when the call was answered with the plain
-- Accept/Decline buttons and no reply was sent.
--
-- Idempotent: scripts/db-init.sh re-applies every non-baseline migration via
-- `prisma db execute` on EVERY container start.

ALTER TABLE "HousekeepingCall" ADD COLUMN IF NOT EXISTS "replyMessage" TEXT;
