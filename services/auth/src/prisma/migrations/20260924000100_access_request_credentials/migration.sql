-- The requester now chooses their own username and password at sign-up time
-- (web/src/pages/RequestAccess.jsx), so approval no longer has to invent
-- either one — see routes/auth.routes.js (access-request) and
-- routes/users.routes.js (approve). Nullable: a request submitted before this
-- migration has neither, and approve() falls back for those.
--
-- Idempotent: scripts/db-init.sh re-applies every non-baseline migration via
-- `prisma db execute` on EVERY container start.

ALTER TABLE "AccessRequest" ADD COLUMN IF NOT EXISTS "username" TEXT;
ALTER TABLE "AccessRequest" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
