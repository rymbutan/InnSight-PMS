-- Generic key/value settings for the auth service. Introduced for Sidebar
-- Visibility (Settings -> Edit System Layout), which is authorisation
-- configuration and so belongs beside the roles it narrows rather than in the
-- reservation service's AppSetting table with the tax rates and the theme.
--
-- IF NOT EXISTS because db-init.sh re-applies every non-baseline migration.sql
-- on EVERY container start; a plain CREATE TABLE fails on the second start and
-- the service crash-loops behind an image that built fine.
CREATE TABLE IF NOT EXISTS "Setting" (
  "key"       TEXT         NOT NULL,
  "value"     TEXT         NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);
