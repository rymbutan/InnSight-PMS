-- Access requests: someone asking for an account from the sign-in screen.
--
-- Deliberately NOT a User. Creating one grants nothing at all — an admin turns
-- an approved request into a real User with real roles. That keeps the
-- default-deny rule intact while giving the "Sign Up" link something honest to
-- do in a system where nobody may enrol themselves.
--
-- Idempotent throughout: scripts/db-init.sh re-applies every non-baseline
-- migration via `prisma db execute` on EVERY container start, so a plain
-- CREATE TYPE or CREATE TABLE would crash the second boot. Postgres has no
-- CREATE TYPE IF NOT EXISTS, hence the DO block.

DO $$
BEGIN
    CREATE TYPE "AccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS "AccessRequest" (
    "id"          TEXT NOT NULL,
    "email"       TEXT NOT NULL,
    "fullName"    TEXT NOT NULL,
    "note"        TEXT,
    "status"      "AccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt"  TIMESTAMP(3),
    "reviewedBy"  TEXT,
    "createdUser" TEXT,

    CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id")
);

-- One live request per address; re-submitting updates the existing row rather
-- than piling up duplicates for an admin to wade through.
CREATE UNIQUE INDEX IF NOT EXISTS "AccessRequest_email_key" ON "AccessRequest"("email");
CREATE INDEX IF NOT EXISTS "AccessRequest_status_createdAt_idx"
    ON "AccessRequest"("status", "createdAt");
