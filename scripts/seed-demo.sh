#!/usr/bin/env bash
# Seeds InnSight PMS with demo room types, rooms, guests, and reservations
# via the gateway API. Idempotent-ish: ignores 409 duplicates.
#
# Usage: bash scripts/seed-demo.sh [GATEWAY_URL]
# Default gateway: http://localhost:8080

set -euo pipefail
cd "$(dirname "$0")/.."

GATEWAY="${1:-http://localhost:8080}"
ADMIN_USER="${ADMIN_USER:-admin}"

# The admin password is no longer a hardcoded `admin12345` — it comes from
# ADMIN_INITIAL_PASSWORD (see scripts/gen-env.sh), and the account is created with
# mustChangePwd, so once you have signed in through the UI this value is stale.
# Pass the current password explicitly in that case:
#
#     ADMIN_PASS='the-password-i-set' bash scripts/seed-demo.sh
ADMIN_PASS="${ADMIN_PASS:-$(grep -E '^ADMIN_INITIAL_PASSWORD=' .env 2>/dev/null | cut -d= -f2- || true)}"

if [ -z "$ADMIN_PASS" ]; then
  echo "ERROR: no admin password available." >&2
  echo "  Either run 'bash scripts/gen-env.sh' (writes ADMIN_INITIAL_PASSWORD to .env)" >&2
  echo "  or pass it: ADMIN_PASS='…' bash scripts/seed-demo.sh" >&2
  exit 1
fi

echo "→ Logging in to $GATEWAY as $ADMIN_USER…"
TOKEN=$(curl -sf -X POST "$GATEWAY/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" \
  | python3 -c "import sys, json; print(json.load(sys.stdin)['token'])")

if [ -z "$TOKEN" ]; then
  echo "ERROR: login failed"; exit 1
fi
echo "  ✓ got token"

H_JSON=(-H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN")

post() {
  local path="$1" body="$2"
  local code
  code=$(curl -s -o /tmp/innsight-seed.out -w "%{http_code}" -X POST "$GATEWAY$path" "${H_JSON[@]}" -d "$body")
  case "$code" in
    2*) echo "  ✓ $path" ;;
    409) echo "  ~ $path already exists (skipped)" ;;
    *)   echo "  ✗ $path → $code"; cat /tmp/innsight-seed.out; echo ;;
  esac
}

echo "→ Room types"
post /api/room-types '{"code":"STD","name":"Standard Room","baseRate":150000,"maxOccupancy":2,"totalInventory":6}'
post /api/room-types '{"code":"DLX","name":"Deluxe Suite","baseRate":280000,"maxOccupancy":3,"totalInventory":4}'

echo "→ Rooms"
for n in 101 102 103 201 202 203; do
  post /api/rooms "{\"number\":\"$n\",\"typeCode\":\"STD\",\"floor\":$((n/100))}"
done
for n in 301 302 401 402; do
  post /api/rooms "{\"number\":\"$n\",\"typeCode\":\"DLX\",\"floor\":$((n/100))}"
done

echo "→ Guests"
post /api/guests '{"firstName":"Maria","lastName":"Santos","email":"maria.santos@example.com","phone":"+639171234567"}'
post /api/guests '{"firstName":"Juan","lastName":"Dela Cruz","email":"juan.dc@example.com","phone":"+639172345678"}'
post /api/guests '{"firstName":"Aiko","lastName":"Reyes","email":"aiko.reyes@example.com","phone":"+639173456789"}'

echo "→ Charge codes"
post /api/charge-codes '{"code":"ROOM","name":"Room charge","category":"ROOM","taxable":true}'
post /api/charge-codes '{"code":"FNB","name":"Food & beverage","category":"FNB","taxable":true}'
post /api/charge-codes '{"code":"LDRY","name":"Laundry","category":"SERVICE","taxable":true}'
post /api/charge-codes '{"code":"MINBAR","name":"Mini-bar","category":"FNB","taxable":true}'

echo "→ Reservations (2 upcoming, 1 today)"
TODAY=$(date +%Y-%m-%d)
TMRW=$(date -v+1d +%Y-%m-%d 2>/dev/null || date -d tomorrow +%Y-%m-%d)
DAY3=$(date -v+3d +%Y-%m-%d 2>/dev/null || date -d '+3 days' +%Y-%m-%d)
DAY5=$(date -v+5d +%Y-%m-%d 2>/dev/null || date -d '+5 days' +%Y-%m-%d)

mkres() {
  local guestName="$1" rt="$2" ci="$3" co="$4"
  curl -s -X POST "$GATEWAY/api/reservations" "${H_JSON[@]}" \
    -d "{\"guestName\":\"$guestName\",\"roomTypeCode\":\"$rt\",\"checkIn\":\"$ci\",\"checkOut\":\"$co\",\"adults\":2,\"totalEstimateCents\":300000,\"depositCents\":100000}" \
    | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('id',''))"
}

confirm() {
  curl -s -X POST "$GATEWAY/api/reservations/$1/confirm" "${H_JSON[@]}" > /dev/null
}

R1=$(mkres "Maria Santos" "STD" "$TODAY" "$TMRW")
[ -n "$R1" ] && confirm "$R1" && echo "  ✓ reservation for Maria ($R1) confirmed (today → tomorrow)"
R2=$(mkres "Juan Dela Cruz" "DLX" "$TMRW" "$DAY3")
[ -n "$R2" ] && confirm "$R2" && echo "  ✓ reservation for Juan ($R2) confirmed"
R3=$(mkres "Aiko Reyes" "STD" "$DAY3" "$DAY5")
[ -n "$R3" ] && confirm "$R3" && echo "  ✓ reservation for Aiko ($R3) confirmed"

echo ""
echo "✓ Seed complete. Visit $GATEWAY and sign in as '$ADMIN_USER'."
