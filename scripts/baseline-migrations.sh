#!/usr/bin/env bash
# Generate the baseline Prisma migration for every service, once.
#
# WHY
# ---
# This project was `prisma db push` managed: no migration history, no rollback,
# and — critically — `db push` diffs the schema against the live database and will
# DROP anything it does not know about. The raw-SQL constraints added in Phase 1
# (the double-booking exclusion constraint, the one-guest-per-room partial unique
# index) are invisible to the Prisma schema, so under `db push` they were liable
# to be silently removed on the next schema change.
#
# `prisma migrate deploy` applies an ordered, immutable list of migrations and
# never diffs, so hand-written SQL survives.
#
# RUN THIS ONCE, LOCALLY, then commit the generated migrations/ directories.
# It needs network access (Prisma downloads its schema engine on first use), so it
# cannot run inside a sandboxed CI step or an offline container.
#
#   bash scripts/baseline-migrations.sh
#
# It is idempotent: services that already have a baseline are skipped.

set -euo pipefail
cd "$(dirname "$0")/.."

SERVICES=(inventory reservation stay folio guest maintenance auth audit reports messaging)

# Pin the CLI major. The services declare `prisma: ^6.0.0`, but most of them have
# no local node_modules on a dev machine, so a bare `npx prisma` reaches for the
# newest release instead — and Prisma 7 removed the `--to-schema-datamodel` flag
# used below, so the run failed on the very first service with a usage error.
# Override with PRISMA_CLI=prisma@<version> if the services' pin ever moves.
PRISMA_CLI="${PRISMA_CLI:-prisma@6}"

# Matches the hand-written constraint migrations committed in Phase 1. The
# baseline must sort BEFORE these so the tables exist when the constraints are
# added — hence the 0-prefixed timestamp.
BASELINE_NAME="00000000000000_baseline"

echo "Generating baseline migrations for ${#SERVICES[@]} services…"
echo

for svc in "${SERVICES[@]}"; do
  schema="services/$svc/src/prisma/schema.prisma"
  migdir="services/$svc/src/prisma/migrations"

  if [ ! -f "$schema" ]; then
    echo "  SKIP $svc — no schema at $schema"
    continue
  fi

  # "Exists" must mean "exists AND is usable". A previous run that died partway
  # through — e.g. on a CLI usage error — leaves behind the mkdir'd directory and
  # an EMPTY migration.sql, because the redirection creates the file before the
  # command writes to it. Treating that as "already done" is the worst possible
  # outcome: db-init.sh sees a baseline, switches to `migrate deploy`, deploy
  # applies zero DDL, and the service starts against a database with no tables.
  # That is exactly the failure mode this project has already been bitten by.
  if [ -s "$migdir/$BASELINE_NAME/migration.sql" ] \
     && [ "$(wc -l < "$migdir/$BASELINE_NAME/migration.sql" | tr -d ' ')" -ge 2 ]; then
    echo "  SKIP $svc — baseline already exists"
    continue
  fi
  if [ -d "$migdir/$BASELINE_NAME" ]; then
    echo "  WARN $svc — found an empty/partial baseline from an earlier run; regenerating"
    rm -rf "$migdir/$BASELINE_NAME"
  fi

  mkdir -p "$migdir/$BASELINE_NAME"

  # Clean up the half-written directory if the generation below fails. `set -e`
  # aborts the script before the emptiness check further down can run, so the
  # check alone was not enough to prevent the partial state described above.
  trap 'rm -rf "$migdir/$BASELINE_NAME"' EXIT

  # --from-empty → the SQL to build the whole schema from nothing.
  # Runs entirely offline against the schema file; no database connection needed.
  ( cd "services/$svc" && npx --yes "$PRISMA_CLI" migrate diff \
      --from-empty \
      --to-schema-datamodel src/prisma/schema.prisma \
      --script ) > "$migdir/$BASELINE_NAME/migration.sql"

  lines=$(wc -l < "$migdir/$BASELINE_NAME/migration.sql" | tr -d ' ')
  if [ "$lines" -lt 2 ]; then
    echo "  FAIL $svc — generated migration is empty; check the schema"
    exit 1   # the EXIT trap removes the directory
  fi
  trap - EXIT
  echo "  OK   $svc — $lines lines → $migdir/$BASELINE_NAME/migration.sql"
done

cat <<'EOF'

──────────────────────────────────────────────────────────────────────────────
Baselines generated. Next steps:

1. FRESH DATABASES (recommended for dev — destroys data):

     docker compose down -v
     docker compose up -d

   Each service now runs `prisma migrate deploy`, which applies the baseline and
   then the Phase 1 constraint migrations in order.

2. EXISTING DATABASE you need to keep:

   The baseline reflects the CURRENT schema, including the Phase 1 columns and
   indexes, so it must not be replayed over a database that predates them. Bring
   the schema up to date once, then tell Prisma the baseline is already applied:

     # per service, e.g. inventory
     cd services/inventory
     npx prisma db push --schema=src/prisma/schema.prisma
     npx prisma migrate resolve --applied 00000000000000_baseline --schema=src/prisma/schema.prisma

   Then `migrate deploy` will apply only the constraint migrations on top.

   The constraint migrations will FAIL if the existing data already violates them
   (double-booked rooms, double-occupied rooms). Each migration.sql contains the
   diagnostic query to find the offending rows — that is intentional: those rows
   are real corruption produced by the pre-fix code, and they need a human
   decision, not a silent DELETE.

3. Commit every services/*/src/prisma/migrations/ directory.
──────────────────────────────────────────────────────────────────────────────
EOF
