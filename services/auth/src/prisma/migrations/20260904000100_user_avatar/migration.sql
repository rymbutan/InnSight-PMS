-- Profile photos for staff accounts.
--
-- Stored inline on User rather than on a volume or in MinIO: nothing in this
-- stack speaks S3, and a container-local volume would diverge the moment a
-- second replica started. See the note on the model in schema.prisma.
--
-- Idempotent, like every other migration here: db-init.sh re-applies each file
-- via `prisma db execute` on every container start.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarData" BYTEA;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarMime" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarUpdatedAt" TIMESTAMP(3);

-- Only the three raster types the upload route accepts. SVG is deliberately
-- absent: it is a script-bearing document, and this column's value is echoed
-- back as the response Content-Type, so allowing it would turn an avatar into a
-- stored-XSS vector on the app's own origin.
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_avatarMime_allowed";
ALTER TABLE "User"
  ADD CONSTRAINT "User_avatarMime_allowed"
  CHECK ("avatarMime" IS NULL OR "avatarMime" IN ('image/png', 'image/jpeg', 'image/webp'));

-- Both halves are written together or not at all; a row with bytes but no type
-- could not be served, and a type with no bytes would advertise an image that
-- does not exist.
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_avatar_complete";
ALTER TABLE "User"
  ADD CONSTRAINT "User_avatar_complete"
  CHECK (("avatarData" IS NULL) = ("avatarMime" IS NULL));
