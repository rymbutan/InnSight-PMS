-- Uploaded .glb fixtures. Idempotent so a re-run against a database that
-- already has the table is a no-op, matching every other migration here.
CREATE TABLE IF NOT EXISTS "RoomAsset" (
  "key"        TEXT NOT NULL,
  "filename"   TEXT NOT NULL,
  "mime"       TEXT NOT NULL,
  "sizeBytes"  INTEGER NOT NULL,
  "data"       BYTEA NOT NULL,
  "uploadedBy" TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoomAsset_pkey" PRIMARY KEY ("key")
);

-- The key is what a layout stores as `model: '<key>'`, so it has to survive a
-- round trip through JSON and a URL path unescaped. Enforced here rather than
-- only in the route, because the column outlives any one version of the API.
DO $$
BEGIN
  ALTER TABLE "RoomAsset"
    ADD CONSTRAINT "RoomAsset_key_format" CHECK ("key" ~ '^[a-z0-9][a-z0-9_-]{0,63}$');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- A single fixture is a compressed mesh, not a video. The cap stops one upload
-- from bloating the row store and every backup that follows it.
DO $$
BEGIN
  ALTER TABLE "RoomAsset"
    ADD CONSTRAINT "RoomAsset_size_sane" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 25165824);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
