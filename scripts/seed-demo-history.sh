#!/usr/bin/env bash
# Two months of demo trading history (July–August), so the Reports and Revenue
# screens have something to show.
#
# WHY THIS IS NOT PART OF scripts/db-seed.sh
# ------------------------------------------
# db-seed.sh writes REFERENCE data — charge codes, room types, roles — and it is
# safe to run against any database at any time. This writes invented REVENUE.
# Running it against a property's real books would put fabricated business days
# and fabricated amenity sales into the same tables the night audit and the
# folio ledger use, which is a different kind of thing entirely. So it is a
# separate script that has to be asked for by name, and it can take itself back
# out again.
#
# WHAT IT WRITES
# --------------
#   audit  : one closed BusinessDay per day — occupancy, ADR, RevPAR, room,
#            facility and other revenue, tax, payments, arrivals, departures.
#   folio  : the individual walk-in amenity sales that make up the facility
#            revenue above, shaped exactly as the POS writes them.
#
# Both derive from services/_shared/demoHistory.js, so the daily facility total
# on the Revenue page equals the sum of the sales in the Amenity report. The
# figures are a pure function of the date: re-running changes nothing.
#
# SAFE TO RE-RUN. A business day that already exists is left alone — including
# one a real night audit closed — and an amenity folio that already exists is
# skipped.
#
#   bash scripts/seed-demo-history.sh            write it
#   bash scripts/seed-demo-history.sh --purge    remove it
#
# Requires the stack to be up (`docker compose up -d`).

set -uo pipefail
cd "$(dirname "$0")/.."

MODE="write"
ARGS=()
if [ "${1:-}" = "--purge" ]; then
  MODE="purge"
  ARGS=(--purge)
fi

if [ ! -f .env ]; then
  echo "ERROR: no .env — run 'bash scripts/gen-env.sh' first." >&2
  exit 1
fi

if [ "$MODE" = "purge" ]; then
  echo "Removing demo trading history…"
else
  echo "Writing demo trading history (July–August)…"
fi
echo

failed=()
for svc in audit folio; do
  printf '  %-8s ' "$svc"
  # Overriding the image CMD, so db-init.sh does not re-run here — same pattern
  # as scripts/db-seed.sh.
  if out=$(docker compose run --rm --no-deps -T "${svc}-service" \
      node src/seedDemoHistory.js "${ARGS[@]}" 2>&1); then
    echo "OK"
    echo "$out" | grep -E '^\[' | sed 's/^/      /'
  else
    echo "FAILED"
    echo "$out" | sed 's/^/      /'
    failed+=("$svc")
  fi
done

echo
if [ "${#failed[@]}" -gt 0 ]; then
  echo "✗ Failed for: ${failed[*]}"
  echo "  Is the stack up? Try: docker compose up -d"
  exit 1
fi

if [ "$MODE" = "purge" ]; then
  echo "✓ Demo history removed."
else
  echo "✓ Demo history written."
  echo "  Reports → Occupancy / Revenue / Amenity Revenue, with 2026-07-01 to 2026-08-31."
  echo "  Revenue page picks it up automatically."
fi
