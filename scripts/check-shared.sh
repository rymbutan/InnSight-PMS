#!/usr/bin/env bash
# Guards against drift between services/_shared/*.js and the byte-identical
# copies each service vendors under src/lib/ (each service's Docker build
# context is its own directory, so it cannot require ../_shared at runtime —
# the code is copied in). This check fails if any vendored copy diverges from
# the canonical _shared version, so a fix to one is not silently lost in the
# others.
#
# Usage: bash scripts/check-shared.sh
# Exit 0 = all in sync, 1 = drift found.

set -uo pipefail
cd "$(dirname "$0")/.."

shared_dir="services/_shared"
status=0

for shared in "$shared_dir"/*.js; do
  base="$(basename "$shared")"
  # Every vendored copy of this file across the services.
  while IFS= read -r copy; do
    [ -z "$copy" ] && continue
    if ! diff -q "$shared" "$copy" >/dev/null 2>&1; then
      echo "DRIFT: $copy differs from $shared"
      status=1
    fi
  done < <(find services -path '*/src/*' -name "$base" -not -path '*/node_modules/*' 2>/dev/null)
done

if [ "$status" -eq 0 ]; then
  echo "✓ shared libs in sync (services/_shared ↔ vendored src/lib copies)"
else
  echo ""
  echo "Fix: copy the canonical services/_shared/<file> over the drifted copy,"
  echo "or update _shared and re-propagate to every vendored copy."
fi
exit "$status"
