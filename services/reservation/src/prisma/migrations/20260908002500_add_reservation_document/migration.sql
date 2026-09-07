-- File metadata only — the bytes live in MinIO under objectKey. See
-- lib/storage.js.
--
-- IF NOT EXISTS: db-init.sh re-applies every non-baseline migration.sql via
-- `prisma db execute` on EVERY container start, so a plain CREATE TABLE would
-- crash the second boot.
CREATE TABLE IF NOT EXISTS "ReservationDocument" (
    "id"            TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "filename"      TEXT NOT NULL,
    "contentType"   TEXT NOT NULL,
    "sizeBytes"     INTEGER NOT NULL,
    "objectKey"     TEXT NOT NULL,
    "uploadedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedBy"    TEXT,

    CONSTRAINT "ReservationDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ReservationDocument_objectKey_key" ON "ReservationDocument"("objectKey");
CREATE INDEX IF NOT EXISTS "ReservationDocument_reservationId_idx" ON "ReservationDocument"("reservationId");

DO $$
BEGIN
  ALTER TABLE "ReservationDocument"
    ADD CONSTRAINT "ReservationDocument_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
