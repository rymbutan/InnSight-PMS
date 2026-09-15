#!/bin/sh
# Database bring-up for a service container. Runs as the first step of each
# service's CMD, replacing the bare `prisma db push` / `prisma migrate deploy`.
#
# WHY NOT JUST `migrate deploy`
# -----------------------------
# `migrate deploy` requires a committed baseline migration that creates the
# tables. Generating one needs network access (Prisma downloads its schema
# engine), so it cannot be produced in every environment, and until
# scripts/baseline-migrations.sh has been run and its output committed there is
# no baseline to apply — `migrate deploy` would no-op and the service would then
# crash seeding into tables that do not exist.
#
# WHY NOT JUST `db push`
# ----------------------
# `db push` diffs the schema against the live database and will DROP objects it
# does not know about. The raw-SQL constraints in migrations/ (the double-booking
# exclusion constraint, the one-guest-per-room partial unique index) are invisible
# to the Prisma schema, so `db push` alone would silently remove them.
#
# So: apply whichever schema mechanism is available, then ALWAYS (re)apply the
# raw-SQL constraint files. Every one of those files is written to be idempotent
# (CREATE ... IF NOT EXISTS / DROP CONSTRAINT IF EXISTS), so re-running is safe
# and repairs anything db push removed.
#
# Usage (from a service directory):  sh ../../scripts/db-init.sh
# or, as vendored into each image:   sh ./db-init.sh

set -e

SCHEMA="${PRISMA_SCHEMA:-src/prisma/schema.prisma}"
MIGRATIONS_DIR="$(dirname "$SCHEMA")/migrations"

echo "[db-init] schema: $SCHEMA"

# ── 1. Bring the schema up to date ──────────────────────────────────────────
# A baseline exists only after scripts/baseline-migrations.sh has been run and
# committed. Detect it by looking for a migration that creates tables.
#
# `-s` (non-empty), not `-f` (exists). An interrupted `scripts/baseline-migrations.sh`
# can leave a 0-byte migration.sql behind: the shell creates the file for the
# output redirection before Prisma writes a single byte. A 0-byte baseline still
# looks like a baseline to `-f`, and `migrate deploy` would then happily apply
# zero DDL, mark the migration as applied, and hand the service a database with no
# tables — every query 500s while the container reports itself healthy. This is
# the same trap that a past `migrate deploy || db push` CMD fell into.
if [ -d "$MIGRATIONS_DIR" ] && [ -s "$MIGRATIONS_DIR/00000000000000_baseline/migration.sql" ]; then
  echo "[db-init] baseline found → prisma migrate deploy"
  npx prisma migrate deploy --schema="$SCHEMA"
else
  echo "[db-init] no baseline → prisma db push (run scripts/baseline-migrations.sh to switch to migrations)"
  npx prisma db push --schema="$SCHEMA" --skip-generate
fi

# ── 2. Always (re)apply raw-SQL constraints ─────────────────────────────────
# Under `migrate deploy` these have already run and are no-ops. Under `db push`
# this is the only thing that installs them — and the only thing that puts them
# back if a later `db push` dropped them.
if [ -d "$MIGRATIONS_DIR" ]; then
  for dir in "$MIGRATIONS_DIR"/*/; do
    [ -d "$dir" ] || continue
    case "$dir" in *00000000000000_baseline*) continue ;; esac
    sql="${dir}migration.sql"
    [ -f "$sql" ] || continue
    echo "[db-init] applying constraints: $(basename "$dir")"
    # Constraint files are idempotent, but a violation of real data must still be
    # loud — it means rows exist that the constraint forbids, which needs a human.
    if ! npx prisma db execute --file "$sql" --schema "$SCHEMA"; then
      echo "[db-init] ERROR: $(basename "$dir") failed to apply." >&2
      echo "[db-init] This usually means existing data VIOLATES the constraint" >&2
      echo "[db-init] (double-booked rooms, or two in-house guests in one room)." >&2
      echo "[db-init] The migration file contains a diagnostic query to find them." >&2
      exit 1
    fi
  done
fi

echo "[db-init] done"
