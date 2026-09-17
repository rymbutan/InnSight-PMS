-- System-wide user activity log: who did what, across every service.
--
-- Rows arrive only from src/subscribers/redis.subscriber.js, which consumes the
-- `activity:recorded` events published by lib/activityLog.js on each successful
-- write request. Nothing writes this table over HTTP — GET /api/activity is
-- read-only so the log cannot be edited from the screen that shows it.
--
-- IF NOT EXISTS throughout is mandatory, not defensive, for the same reason the
-- facility-revenue migration documents: db-init.sh re-applies every non-baseline
-- migration.sql with `prisma db execute` on EVERY container start, so a plain
-- CREATE TABLE would fail on the second start and crash-loop the service behind a
-- healthy-looking image.
--
-- No body/payload column, deliberately. Request bodies carry passwords
-- (/api/auth/login, /api/auth/reset) and guest PII nearly everywhere; this table
-- is browsed casually by admins and is the wrong home for either. See the header
-- of services/_shared/activityLog.js.
CREATE TABLE IF NOT EXISTS "ActivityLog" (
    "id"         TEXT NOT NULL,
    "at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "service"    TEXT NOT NULL,
    -- Nullable: a public booking or a token-redeemed password reset is a real
    -- successful write with no session behind it.
    "actorId"    TEXT,
    "actorName"  TEXT NOT NULL DEFAULT 'unknown',
    "actorRoles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "action"     TEXT NOT NULL,
    "summary"    TEXT NOT NULL,
    "method"     TEXT NOT NULL,
    "path"       TEXT NOT NULL,
    "targetType" TEXT,
    "targetId"   TEXT,
    "status"     INTEGER NOT NULL,
    "requestId"  TEXT,
    "ip"         TEXT,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- The three questions the admin screen asks, each newest-first. `at` trails every
-- index because without it Postgres can use the index to find the matching rows
-- and then still has to sort them by hand — which is the whole cost on a table
-- that only ever grows.
CREATE INDEX IF NOT EXISTS "ActivityLog_at_idx" ON "ActivityLog"("at");
CREATE INDEX IF NOT EXISTS "ActivityLog_actorId_at_idx" ON "ActivityLog"("actorId", "at");
CREATE INDEX IF NOT EXISTS "ActivityLog_action_at_idx" ON "ActivityLog"("action", "at");
CREATE INDEX IF NOT EXISTS "ActivityLog_service_at_idx" ON "ActivityLog"("service", "at");
