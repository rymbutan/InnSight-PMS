-- A card ON FILE as a booking guarantee, not a payment. This is a non-PCI-
-- compliant capstone build, so there is deliberately no column here that could
-- hold a full card number or a CVV — only what a receipt already shows.
--
-- IF NOT EXISTS: db-init.sh re-applies every non-baseline migration.sql via
-- `prisma db execute` on EVERY container start, so a plain CREATE TABLE would
-- crash the second boot.
CREATE TABLE IF NOT EXISTS "ReservationCard" (
    "id"             TEXT NOT NULL,
    "reservationId"  TEXT NOT NULL,
    "brand"          TEXT NOT NULL,
    "last4"          TEXT NOT NULL,
    "expMonth"       INTEGER NOT NULL,
    "expYear"        INTEGER NOT NULL,
    "cardholderName" TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy"      TEXT,

    CONSTRAINT "ReservationCard_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ReservationCard_reservationId_idx" ON "ReservationCard"("reservationId");

DO $$
BEGIN
  ALTER TABLE "ReservationCard"
    ADD CONSTRAINT "ReservationCard_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
