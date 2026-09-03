#!/usr/bin/env bash
# Applies Prisma schema changes to the running services.
#
# This project is db-push-managed (no migrations directory). We use
# `prisma db push` — NOT `migrate dev`/`migrate deploy`, which would detect
# drift and can reset the database.
#
# Run after `docker compose up -d`:
#   bash scripts/migrate.sh

set -euo pipefail

cd "$(dirname "$0")/.."

migrate() {
  local svc="$1"
  echo ""
  echo "→ Syncing schema for $svc…"
  # No --accept-data-loss: a destructive change should fail loudly and be
  # handled deliberately rather than silently dropping columns/data.
  docker compose exec -T "$svc" npx prisma db push --schema=src/prisma/schema.prisma
  docker compose exec -T "$svc" npx prisma generate --schema=src/prisma/schema.prisma
  docker compose restart "$svc"
}

migrate reservation-service
migrate folio-service

echo ""
echo "✓ Migrations applied. The reservation + folio services have been restarted."
echo "  Visit the app at http://localhost:5180"
