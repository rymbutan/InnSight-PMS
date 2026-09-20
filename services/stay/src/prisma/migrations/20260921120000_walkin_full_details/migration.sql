-- A walk-in has no backing Reservation, so it had nowhere to carry the same
-- detail NewReservation.jsx's wizard already collects for a reserved booking:
-- special requests, priced add-ons, and per-method deposit detail. These
-- mirror Reservation's own columns of the same name.
ALTER TABLE "Stay" ADD COLUMN IF NOT EXISTS "specialRequests" TEXT;
ALTER TABLE "Stay" ADD COLUMN IF NOT EXISTS "addOns" JSONB;
ALTER TABLE "Stay" ADD COLUMN IF NOT EXISTS "paymentType" TEXT;
ALTER TABLE "Stay" ADD COLUMN IF NOT EXISTS "depositCardMasked" TEXT;
ALTER TABLE "Stay" ADD COLUMN IF NOT EXISTS "depositCardholderName" TEXT;
ALTER TABLE "Stay" ADD COLUMN IF NOT EXISTS "depositBankName" TEXT;
ALTER TABLE "Stay" ADD COLUMN IF NOT EXISTS "depositTransferNetwork" TEXT;
ALTER TABLE "Stay" ADD COLUMN IF NOT EXISTS "depositSenderName" TEXT;
ALTER TABLE "Stay" ADD COLUMN IF NOT EXISTS "depositGatewayRef" TEXT;
ALTER TABLE "Stay" ADD COLUMN IF NOT EXISTS "depositTransferredAt" TIMESTAMP(3);
