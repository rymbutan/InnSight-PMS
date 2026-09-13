-- Self-service password reset, for the "Forgot password?" link on sign-in.
--
-- The token itself is NEVER stored. Only its SHA-256 hash lands here, so a dump
-- of this table yields nothing a person could paste into a reset link — the
-- plaintext exists only in the email and in the user's address bar.
--
-- IF NOT EXISTS throughout because db-init.sh re-applies every non-baseline
-- migration on each container start by design.
CREATE TABLE IF NOT EXISTS "PasswordReset" (
  "id"        TEXT         NOT NULL,
  "userId"    TEXT         NOT NULL,
  "tokenHash" TEXT         NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
);

-- Unique: the hash is how a redemption finds its row, and two rows sharing one
-- would make "which reset is this?" ambiguous at exactly the wrong moment.
CREATE UNIQUE INDEX IF NOT EXISTS "PasswordReset_tokenHash_key" ON "PasswordReset" ("tokenHash");
-- Requesting a reset invalidates that user's outstanding ones, and the throttle
-- counts recent rows per user; both read by userId.
CREATE INDEX IF NOT EXISTS "PasswordReset_userId_createdAt_idx" ON "PasswordReset" ("userId", "createdAt");
