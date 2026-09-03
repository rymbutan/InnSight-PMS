-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "StayStatus" AS ENUM ('PRE_ARRIVAL', 'IN_HOUSE', 'DEPARTED', 'NO_SHOW');

-- CreateTable
CREATE TABLE "Stay" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT,
    "guestId" TEXT,
    "assignedRoomId" TEXT,
    "folioId" TEXT,
    "actualCheckInAt" TIMESTAMP(3),
    "actualCheckOutAt" TIMESTAMP(3),
    "status" "StayStatus" NOT NULL DEFAULT 'PRE_ARRIVAL',
    "keyCardsIssued" INTEGER NOT NULL DEFAULT 0,
    "idVerification" JSONB,
    "depositAmount" INTEGER NOT NULL DEFAULT 0,
    "guestName" TEXT,
    "expectedCheckIn" TIMESTAMP(3),
    "expectedCheckOut" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckInTask" (
    "taskId" TEXT NOT NULL,
    "stayId" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "currentStep" TEXT NOT NULL,
    "stepStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckInTask_pkey" PRIMARY KEY ("taskId")
);

-- CreateIndex
CREATE INDEX "Stay_status_expectedCheckIn_idx" ON "Stay"("status", "expectedCheckIn");

-- CreateIndex
CREATE INDEX "Stay_status_expectedCheckOut_idx" ON "Stay"("status", "expectedCheckOut");

-- CreateIndex
CREATE INDEX "Stay_assignedRoomId_status_idx" ON "Stay"("assignedRoomId", "status");

-- CreateIndex
CREATE INDEX "Stay_reservationId_idx" ON "Stay"("reservationId");

-- CreateIndex
CREATE INDEX "Stay_folioId_idx" ON "Stay"("folioId");

-- CreateIndex
CREATE INDEX "Stay_guestId_idx" ON "Stay"("guestId");

-- CreateIndex
CREATE INDEX "CheckInTask_stayId_idx" ON "CheckInTask"("stayId");

-- AddForeignKey
ALTER TABLE "CheckInTask" ADD CONSTRAINT "CheckInTask_stayId_fkey" FOREIGN KEY ("stayId") REFERENCES "Stay"("id") ON DELETE CASCADE ON UPDATE CASCADE;

