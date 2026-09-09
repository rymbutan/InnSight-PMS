-- A record of every attempted booking-confirmation dispatch — Email, SMS, and
-- Viber alike. Email already has Mailhog as an inspectable "sent mail" view;
-- SMS and Viber have no such tool (there is no real provider anywhere in this
-- stack), so this is the only record of what would have gone out.
--
-- IDEMPOTENT BY REQUIREMENT: db-init.sh re-applies every non-baseline
-- migration.sql via `prisma db execute` on EVERY container start, so a plain
-- CREATE TYPE / CREATE TABLE fails on the second start with "already exists"
-- and the service crash-loops behind an image that built fine — the same
-- trap every other migration in this directory documents.
DO $$
BEGIN
  CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SMS', 'VIBER');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS "NotificationLog" (
    "id"            TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "channel"       "NotificationChannel" NOT NULL,
    "to"            TEXT NOT NULL,
    "subject"       TEXT,
    "body"          TEXT NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'SENT',
    "error"         TEXT,
    "sentAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "NotificationLog_reservationId_sentAt_idx" ON "NotificationLog"("reservationId", "sentAt");

DO $$
BEGIN
  ALTER TABLE "NotificationLog"
    ADD CONSTRAINT "NotificationLog_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
