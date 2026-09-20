-- The reason (and optional screenshot evidence) an auditor or manager gives
-- when disputing/cancelling a charge. A void/reversal could already be
-- posted through POST /folios/:id/void-transaction/:txId, but it captured no
-- reason and stamped no actor onto the reversal row it created — this fixes
-- both.
--
-- IF NOT EXISTS / ON CONFLICT throughout: scripts/db-init.sh re-applies every
-- non-baseline migration file via `prisma db execute` on EVERY container
-- start, on top of whatever `prisma migrate deploy` already did.
CREATE TABLE IF NOT EXISTS "FolioTransactionDispute" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "reversalTransactionId" TEXT,
    "reason" TEXT NOT NULL,
    "filedBy" TEXT,
    "filedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "screenshotFilename" TEXT,
    "screenshotContentType" TEXT,
    "screenshotSizeBytes" INTEGER,
    "screenshotObjectKey" TEXT,

    CONSTRAINT "FolioTransactionDispute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FolioTransactionDispute_transactionId_key"
  ON "FolioTransactionDispute" ("transactionId");
CREATE UNIQUE INDEX IF NOT EXISTS "FolioTransactionDispute_screenshotObjectKey_key"
  ON "FolioTransactionDispute" ("screenshotObjectKey");

ALTER TABLE "FolioTransactionDispute" DROP CONSTRAINT IF EXISTS "FolioTransactionDispute_transactionId_fkey";
ALTER TABLE "FolioTransactionDispute"
  ADD CONSTRAINT "FolioTransactionDispute_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "FolioTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
