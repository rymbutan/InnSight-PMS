-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "ReportRun" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "params" JSONB,
    "result" JSONB,
    "runBy" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "errorMsg" TEXT,

    CONSTRAINT "ReportRun_pkey" PRIMARY KEY ("id")
);

