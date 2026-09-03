# InnSight PMS

A hotel Property Management System built as an SLSU capstone: front desk,
housekeeping, folios, night audit, and a 3D first-person room-inspection training sim.

Nine Node/Express microservices behind an nginx gateway, a React + Vite SPA, Postgres,
Redis. Money is integer cents throughout.

---

## Quick start

You need **Docker Desktop** (or Docker Engine + Compose v2) and **Node 20+**.

```bash
bash scripts/gen-env.sh          # 1. generate secrets — compose won't start without them
docker compose up -d --build     # 2. build and start (first build takes a few minutes)
bash scripts/db-seed.sh          # 3. create roles, catalogues and the admin account
```

Then open **http://localhost:8080** and sign in as `admin` with the
`ADMIN_INITIAL_PASSWORD` that step 1 printed. You will be required to change it
immediately — that password is valid for exactly one sign-in.

Optional demo data (room types, rooms, guests, a few reservations):

```bash
bash scripts/seed-demo.sh
```

### Why three steps and not one

Two things that used to be implicit are now deliberate:

1. **Every secret is required.** `docker-compose.yml` declares each one as
   `${VAR:?message}` with no fallback. The old defaults were values committed to
   this repository, so a stack that never wrote a `.env` silently ran on public
   credentials.
2. **Seeding is not automatic.** It used to run on every container start, which
   meant two replicas raced two seeds, and the admin password was re-derived and
   printed to `docker logs` on every boot.

Skip step 3 and every service will be healthy but nobody can log in.

---

## Where things are

| URL | What |
|---|---|
| http://localhost:8080 | **The app.** The gateway is the browser's only origin. |
| http://localhost:5180 | Same thing (kept for old bookmarks). |
| http://localhost:8080/health | Gateway health |
| http://localhost:8080/docs/auth/ | Per-service Swagger UI (`/docs/<service>/`) |
| http://localhost:8025 | Mailhog — catches all outbound email |

The nine services do **not** publish ports. They are reachable only inside the
compose network, so the gateway's rate limiting, CORS allowlist and security headers
cannot be bypassed. For debugging, opt in:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

---

## Repository layout

```
services/
  _shared/           canonical shared libs — VENDORED into each service's src/lib
  gateway/           nginx: serves the SPA at /, proxies /api/*, rate limits
  auth/              users, roles, permissions, JWT issuance, training results
  inventory/         rooms, room types, rate plans, holds, facilities, SSE bridge
  reservation/       bookings (public + staff), the availability/hold protocol
  stay/              check-in/out, walk-ins, arrivals/departures/in-house
  folio/             charges, payments, statements, printable folios
  guest/             guest profiles, preferences, consents, loyalty
  maintenance/       work orders, assets, parts
  audit/             night audit / business-day close
  reports/           operational and revenue reporting
web/                 React + Vite SPA
  public/models/     3D assets (.glb) — NOT under src/, see below
  src/sim/           the training sim (room renderer + layout editor)
  src/sim/inspection/  the room-inspection case study students actually run
scripts/             operational scripts (see below)
```

### `services/_shared` is vendored, not imported

Each service's Docker build context is its own directory, so it **cannot**
`require('../_shared/...')` at runtime. Instead every service keeps a byte-identical
copy under `services/<svc>/src/lib/`.

To change shared code: edit `services/_shared/<file>.js`, copy it over every
`services/*/src/lib/<file>.js`, then run `bash scripts/check-shared.sh`. That check
runs in CI and in the pre-commit hook, so drift fails the build rather than rotting
quietly.

---

## Scripts

| Script | What it does |
|---|---|
| `scripts/gen-env.sh` | Generate `.env` with strong secrets. `--force` to regenerate. |
| `scripts/db-seed.sh` | Run every service's seed once, as throwaway containers. |
| `scripts/seed-demo.sh` | Create demo rooms/guests/reservations through the API. |
| `scripts/check-shared.sh` | Fail if a vendored `_shared` copy has drifted. |
| `scripts/check-room-layouts.mjs` | Validate the 3D rooms — reachability **and** geometry. `--sizes` prints rendered fixture sizes. |
| `scripts/measure-models.mjs` | Measure every `.glb`: bounding box, triangles, textures. |
| `scripts/optimize-models.sh` | Compress models (meshopt + WebP). Stages; never overwrites. |
| `scripts/prove-no-double-booking.mjs` | Fire N simultaneous bookings and assert exactly one wins. |
| `scripts/baseline-migrations.sh` | Generate the Prisma baseline migration per service (run once). |
| `scripts/backfill-inventory-holds.mjs` | Backfill holds for reservations created before the hold model. |

---

## Development

```bash
cd web && npm ci && npm run dev     # SPA on :5173, proxies /api to :8080
```

The dev server expects the stack to be running (it proxies `/api` to the gateway).
The `web` container itself runs **nginx over the built bundle**, not the dev server.

Backend changes need a rebuild — this is also what applies new migrations:

```bash
docker compose build auth-service && docker compose up -d auth-service
```

### Tests and lint

```bash
cd services/<svc> && npm ci && npm test     # per service
npx prettier --check "web/src/**/*.{js,jsx,css}" "services/**/*.js"
npx eslint "web/src/**/*.{js,jsx}" "services/**/*.js" --max-warnings=0
node scripts/check-room-layouts.mjs
```

240 unit tests across the nine services. Notable ones:

- **Booking races** — 20 simultaneous bookings against one room must yield exactly
  one winner and 19 clean 409s (`inventory/holds.test.js`, `reservation.test.js`).
- **Authorization** — every service has an `authz.test.js` that walks its router and
  fails if **any** route lacks a role guard. Express authorization is opt-in, so this
  is what makes "default deny" real: a new unguarded route fails CI.
- **Training scoring** — pins the case-sensitivity bug that once made every training
  run score 0%.
- **Inspection case study** — `sim/inspection/` covers case coherence (a defect is
  never injected into a booking that cannot support it), the six defect definitions,
  and the grading rules, including the guarantee that flagging every object fails.

### Database migrations

`scripts/db-init.sh` runs at container start and picks the mechanism: `prisma
migrate deploy` when a non-empty baseline exists (it does), then re-applies the
raw-SQL constraint migrations, which are written to be idempotent.

Those constraints — a `daterange` exclusion constraint against double-booking, a
partial unique index for one in-house guest per room — are invisible to the Prisma
schema, which is why `db push` alone was unsafe: it drops what it doesn't know about.

Adding a migration: write `services/<svc>/src/prisma/migrations/<timestamp>_<name>/migration.sql`
using `IF NOT EXISTS` / `DROP ... IF EXISTS`, since `db-init.sh` re-applies
non-baseline migrations on every start by design.

Reset everything (**destroys all data**):

```bash
docker compose down -v && docker compose up -d && bash scripts/db-seed.sh
```

---

## Architecture notes worth knowing before you change things

**The gateway is the browser's only origin.** It serves the SPA at `/` and handles
`/api/*`. This is not cosmetic: it is what makes `$remote_addr` the real client, so
rate limiting is per-user instead of hotel-wide. Pointing the browser at the `web`
container directly silently undoes that.

**Availability is decided by a hold, not a read.** Reservation asks inventory for a
hold, taken under a `SELECT … FOR UPDATE` inside inventory's own transaction. The
availability number the UI shows is advisory only — acting on it would be a
time-of-check/time-of-use race across two databases.

**Business dates are LOCAL days.** Use `localDay()` / `startOfLocalDay()` from
`_shared/date.js`. `new Date(x).toISOString().slice(0,10)` is a silent bug at
UTC+8: it lands on the previous day.

**Live updates**: services publish to Redis; inventory bridges Redis → browser over
SSE with ONE process-wide subscriber. Pages subscribe to named channel groups
(`useLiveRefresh(load, { channels: channels('reservations') })`) — subscribing to
everything meant a minibar charge triggered an 8-request dashboard reload in every
open tab. SSE auth uses single-use 30-second tickets, never the session JWT.

**One `PrismaClient` per service** (`src/lib/prisma.js`), with `connection_limit` on
every `DATABASE_URL`. There were once 19 clients across 9 processes — about 171
possible connections against Postgres' 100.

**3D models live in `web/public/models/`, never under `src/`.** A
`new URL('./x.glb', import.meta.url)` reference inside `src/` makes Vite emit a
content-hashed copy of every model into `dist/assets` — which is how ~1 GB of
duplicated `.glb` files once ended up committed. Model sizes come from
`web/src/sim/modelSizes.js`; CI asserts no `.glb` appears in `dist/assets`.

**Only one `<Canvas>` may be mounted at a time.** Two WebGL contexts cause
`Context Lost`. The free-roam room unmounts itself while a task panel is open.

**The room layout editor is ADMIN-only** — `/room-layouts`, reachable from the
hamburger menu as *Room Layouts (3D)*. It edits the geometry the training sim renders,
so it is gated at the route, not merely hidden from the nav. Its overlay sits at
`z-index: 400` because the app header is sticky at `100`. See
`HOW-TO-OPEN-EDITOR.md`.

---

## Security posture

Implemented:

- No secret has a default; every one is required at startup, and the known-published
  values from this repo's history are rejected **by value**.
- Human sessions and machine-to-machine tokens use **separate signing keys**, and
  verification pins algorithm, issuer and audience.
- Logout revokes the token. Disabling a user, resetting or changing a password, or
  changing roles revokes **all** of that user's sessions (Redis denylist + per-user
  epoch).
- Every business route carries an explicit role guard, enforced by a test.
- Security headers and a CSP at the gateway; service ports are not published;
  containers run as a non-root user; SSE uses one-time tickets and nginx does not log
  query strings.
- Per-account lockout after 5 failed logins, plus a dedicated nginx rate-limit zone
  for `/api/auth/login`.

**Known gaps** — read `PHASE_5_CHANGES.md` for detail:

- **No TLS.** The stack listens on plain `:8080`. HSTS is present but commented out
  precisely because enabling it over http would lock browsers out.
- **JWT signing is still symmetric.** A compromised service can mint a *machine*
  token (not a human session). The complete fix is asymmetric signing with auth as
  the only issuer.
- **No schema validation library.** Input validation is ad-hoc truthiness checks, so
  a malformed enum can produce a 500 where a 400 belongs. No SQL injection risk —
  all access is Prisma with structured `where` objects and zero raw SQL.
- Tokens live in `localStorage` (XSS-readable) and there are no refresh tokens.

---

## Project history

The work is documented phase by phase. `InnSight_Technical_Findings.md` is the
original audit; each `PHASE_N_CHANGES.md` says what changed, why, and what was
verified — including what was **not** verified.

| Doc | Scope |
|---|---|
| `PHASE_1_CHANGES.md` | Correctness: double-booking, availability, business dates, indexes |
| `PHASE_2_CHANGES.md` | Deployability: real frontend build, secrets, migrations, rate limiting, SSE fanout, connection pools |
| `PHASE_3_CHANGES.md` | The 3D room: model scaling, lighting, layout geometry, 1011 MB → 44 MB |
| `PHASE_4_CHANGES.md` | The mini-games: scoring, persistence, real mechanics (**superseded** — the mini-games were replaced by the inspection case study) |
| `PHASE_5_CHANGES.md` | Security hardening, CI, this README |
| `HOW-TO-OPEN-EDITOR.md` | Using the 3D room layout editor (**☰ → Room Layouts (3D)**, ADMIN only), and adding a new `.glb` |

`.attic/` holds quarantined build output and the uncompressed original 3D assets.
Read `.attic/README.md` before deleting it — one subdirectory is the only copy of
those originals.
