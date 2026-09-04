#!/usr/bin/env bash
# Clear a locked-out account, and optionally give it a fresh password.
#
# WHY THIS SCRIPT HAS TO EXIST
# ----------------------------
# Five wrong passwords set User.status = 'LOCKED' (services/auth/src/routes/
# auth.routes.js, MAX_FAILED = 5). That lock is PERMANENT — there is no expiry
# timer, so waiting never clears it, and neither does restarting the stack or
# re-running scripts/db-seed.sh (the auth seed skips the admin user when it
# already exists).
#
# The intended cure is POST /api/users/:id/enable, but it is behind
# `verifyToken` + `requireRole('ADMIN','MANAGER')` — it needs somebody already
# signed in. On a fresh install `admin` is the ONLY account, so locking it locks
# the door with the key inside: there is no route back in through the app at all.
#
# Hence this script, which does exactly what that endpoint does
# (status = 'ACTIVE', failedAttempts = 0) but reaches Postgres directly.
#
# A note on why the lockout is so easy to trip: ADMIN_INITIAL_PASSWORD is
# generated, printed once, and typed by hand, so the first sign-in on a new
# database is precisely when you have the least margin for error.
#
#   bash scripts/unlock-admin.sh                     # unlock 'admin'
#   bash scripts/unlock-admin.sh nightauditor        # unlock another account
#   bash scripts/unlock-admin.sh admin --reset-password
#   bash scripts/unlock-admin.sh admin --grant-admin
#
# --grant-admin re-grants the ADMIN role. PUT /api/users/:id/roles now refuses to
# remove the last one, but a database that lost its only administrator before
# that guard existed still needs a way back: granting ADMIN through the API
# requires an ADMIN, so with none left there is no route in through the app.
#
# --reset-password also issues a new password, generated from the same
# unambiguous alphabet scripts/gen-env.sh uses (no I/l/1/O/0), prints it once,
# and flags the account mustChangePwd so the value is good for one sign-in.
# Use it when the password itself is lost, not just when the account is locked.
#
# Requires the stack to be up (`docker compose up -d`).

set -uo pipefail
cd "$(dirname "$0")/.."

USERNAME="admin"
RESET_PW=0
GRANT_ADMIN=0

for arg in "$@"; do
  case "$arg" in
    --reset-password) RESET_PW=1 ;;
    --grant-admin) GRANT_ADMIN=1 ;;
    -*) echo "ERROR: unknown option '$arg'" >&2; exit 1 ;;
    *)  USERNAME="$arg" ;;
  esac
done

if ! docker compose ps --format '{{.Service}}' 2>/dev/null | grep -qx postgres; then
  echo "ERROR: the postgres container is not running." >&2
  echo "       Start the stack first: docker compose up -d" >&2
  exit 1
fi

psql_auth() { docker compose exec -T postgres psql -U innsight -d innsight_auth -tAc "$1"; }

# Fail loudly on a username that does not exist. Without this check the UPDATE
# below reports success having matched zero rows, which reads as "unlocked" while
# the real account stays locked.
exists="$(psql_auth "SELECT 1 FROM \"User\" WHERE username = '${USERNAME//\'/\'\'}';")"
if [ -z "$exists" ]; then
  echo "ERROR: no account named '$USERNAME'." >&2
  echo "       Accounts in the database:" >&2
  psql_auth "SELECT username || ' (' || status || ')' FROM \"User\" ORDER BY username;" \
    | sed 's/^/         /' >&2
  exit 1
fi

before="$(psql_auth "SELECT status || ' / ' || \"failedAttempts\" FROM \"User\" WHERE username = '${USERNAME//\'/\'\'}';")"
echo "  $USERNAME — before: $before  (status / failedAttempts)"

psql_auth "UPDATE \"User\" SET status = 'ACTIVE', \"failedAttempts\" = 0 WHERE username = '${USERNAME//\'/\'\'}';" >/dev/null

if [ "$RESET_PW" -eq 1 ]; then
  if ! command -v openssl >/dev/null 2>&1; then
    echo "✗ Unlocked, but openssl is not available to generate a password safely." >&2
    exit 1
  fi
  NEW_PW="$(openssl rand -base64 64 | tr -d '\n/+=@:?#Il1O0' | cut -c1-24)"
  # Hashed by the auth image's own bcryptjs at the same cost factor the app uses,
  # so the stored hash is indistinguishable from one the app wrote itself.
  if ! docker compose run --rm --no-deps -T \
        -e RESET_USERNAME="$USERNAME" -e RESET_PASSWORD="$NEW_PW" \
        auth-service node -e '
          const bcrypt = require("bcryptjs");
          const { PrismaClient } = require("@prisma/client");
          const prisma = new PrismaClient();
          (async () => {
            const passwordHash = await bcrypt.hash(process.env.RESET_PASSWORD, 10);
            await prisma.user.update({
              where: { username: process.env.RESET_USERNAME },
              data: { passwordHash, mustChangePwd: true, status: "ACTIVE", failedAttempts: 0 },
            });
          })().catch((e) => { console.error(e.message); process.exit(1); })
            .finally(() => prisma.$disconnect());
        ' >/dev/null 2>&1; then
    echo "✗ Unlocked, but the password reset FAILED. The old password still works." >&2
    exit 1
  fi
  echo
  echo "  New password for '$USERNAME':"
  echo
  echo "      $NEW_PW"
  echo
  echo "  Copy it now — it is not stored anywhere and is not in .env."
  echo "  You will be required to change it on sign-in."
fi

if [ "$GRANT_ADMIN" -eq 1 ]; then
  # Additive, and idempotent via the composite primary key: this restores access
  # without touching whatever other roles the account already holds.
  psql_auth "INSERT INTO \"UserRole\" (\"userId\", \"roleCode\") SELECT id, 'ADMIN' FROM \"User\" WHERE username = '${USERNAME//\'/\'\'}' ON CONFLICT DO NOTHING;" >/dev/null
  roles="$(psql_auth "SELECT string_agg(ur.\"roleCode\", ', ' ORDER BY ur.\"roleCode\") FROM \"UserRole\" ur JOIN \"User\" u ON u.id = ur.\"userId\" WHERE u.username = '${USERNAME//\'/\'\'}';")"
  echo "  $USERNAME — roles:  ${roles:-(none)}"
  # Roles are baked into the JWT, so a token minted before this still says
  # otherwise. The app re-reads them at sign-in, hence the note below.
  echo "  Sign out and back in for the new role to take effect."
fi

after="$(psql_auth "SELECT status || ' / ' || \"failedAttempts\" FROM \"User\" WHERE username = '${USERNAME//\'/\'\'}';")"
echo "  $USERNAME — after:  $after"
echo
echo "✓ '$USERNAME' can sign in again at http://localhost:8080"
echo
echo "  To avoid needing this script again, create a SECOND account with the"
echo "  ADMIN or MANAGER role while you are signed in. With two admins, a lockout"
echo "  is a click in the Users screen instead of a trip into psql."
