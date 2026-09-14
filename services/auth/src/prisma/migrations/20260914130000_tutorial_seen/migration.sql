-- First-run product tour, tracked per account.
--
-- A boolean on User rather than localStorage: the tour is meant to greet an
-- ACCOUNT the first time it opens the app, not a browser — the same account
-- signing in from a different desk/PC should not see it twice, and clearing
-- site data should not bring it back.
--
-- Idempotent, like every other migration here: db-init.sh re-applies each
-- file via `prisma db execute` on every container start.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "hasSeenTutorial" BOOLEAN NOT NULL DEFAULT false;
