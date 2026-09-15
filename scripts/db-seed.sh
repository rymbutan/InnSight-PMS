#!/usr/bin/env bash
# Seed every service's reference data ONCE, as a set of one-shot containers.
#
# WHY THIS IS NOT IN THE SERVICE CMD ANY MORE
# -------------------------------------------
# Each service's Dockerfile used to run:
#
#     sh ./db-init.sh && node src/seed.js && node src/index.js
#
# so the seed re-ran on every single container start. Two consequences:
#
#  1. Two replicas of a service = two seeds racing on the same rows. That is one
#     of the things that made the stack non-scalable (finding B6).
#  2. For auth specifically, the admin credentials were re-derived and PRINTED on
#     every boot, so the live password sat in `docker logs` forever (finding B5).
#
# The startup command is now just `db-init.sh && node src/index.js`. Schema
# migration still happens per-container (it is idempotent and the service cannot
# run without it); seeding is this script.
#
# Idempotent: every seed.js upserts, so re-running is safe. The auth seed skips
# the admin user if it already exists.
#
#   bash scripts/db-seed.sh              # seed all 9 services
#   bash scripts/db-seed.sh auth         # seed one service
#
# Requires the stack to be up already (`docker compose up -d`), because the seeds
# connect to Postgres.

set -uo pipefail
cd "$(dirname "$0")/.."

ALL=(auth inventory guest folio stay reservation maintenance audit reports messaging)

if [ "$#" -gt 0 ]; then
  SERVICES=("$@")
else
  SERVICES=("${ALL[@]}")
fi

if [ ! -f .env ]; then
  echo "ERROR: no .env — run 'bash scripts/gen-env.sh' first." >&2
  exit 1
fi

# The auth seed refuses to create the admin account without this, and it must not
# be one of the values published in this repo. Check here too so the failure is a
# clear message rather than a container exiting mid-run.
if printf '%s\n' "${SERVICES[@]}" | grep -qx auth; then
  admin_pw="$(grep -E '^ADMIN_INITIAL_PASSWORD=' .env | cut -d= -f2- || true)"
  if [ -z "$admin_pw" ]; then
    echo "ERROR: ADMIN_INITIAL_PASSWORD is not set in .env." >&2
    echo "       Add one (>= 12 chars) or re-run: bash scripts/gen-env.sh --force" >&2
    exit 1
  fi
  if [ "${#admin_pw}" -lt 12 ]; then
    echo "ERROR: ADMIN_INITIAL_PASSWORD is only ${#admin_pw} characters; use at least 12." >&2
    exit 1
  fi
fi

echo "Seeding ${#SERVICES[@]} service(s)…"
echo

failed=()
for svc in "${SERVICES[@]}"; do
  printf '  %-14s ' "$svc"
  # --rm       : the container is throwaway
  # --no-deps  : do not restart postgres/redis; they are already up
  # -T         : no TTY, so this works unchanged in CI
  #
  # `node src/seed.js` overrides the image CMD, so db-init.sh does NOT re-run here.
  if out=$(docker compose run --rm --no-deps -T "${svc}-service" node src/seed.js 2>&1); then
    echo "OK"
  else
    echo "FAILED"
    echo "$out" | sed 's/^/      /'
    failed+=("$svc")
  fi
done

echo
if [ "${#failed[@]}" -gt 0 ]; then
  echo "✗ Seed failed for: ${failed[*]}"
  echo "  Is the stack up? Try: docker compose up -d"
  exit 1
fi

echo "✓ Seed complete."
echo
echo "  Sign in at http://localhost:8080 (or http://localhost:5180) as 'admin'"
echo "  with ADMIN_INITIAL_PASSWORD from .env. You will be required to change it."
