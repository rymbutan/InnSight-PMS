# Phase 1 — Booking correctness

Closes the double-booking race and the date-handling bugs. 212 unit tests pass.

---

## ⚠️ Two commands before you deploy

**1. Back-fill inventory holds for existing bookings.** Availability is now derived
entirely from `InventoryHold` rows. Reservations created by the old code have no
hold, so without this the hotel reads as 100% empty and every existing booking
can be sold over.

```bash
docker compose up -d
node scripts/backfill-inventory-holds.mjs --dry-run   # inspect first
node scripts/backfill-inventory-holds.mjs
```

If it reports `OVERSOLD` rows, those are real pre-existing double-bookings made by
the old code. They need a human decision — the script deliberately refuses to
guess.

**2. Prove the race is closed.**

```bash
node scripts/prove-no-double-booking.mjs
```

Fires 20 simultaneous bookings at a 1-room type and asserts exactly one wins.
This is also wired into CI's compose-smoke job, and it's the artifact to demo in
a defence.

Optional, recommended once: `bash scripts/baseline-migrations.sh` generates real
Prisma migrations and commits you to `migrate deploy`. Until you run it, services
boot with `db push` plus the raw-SQL constraints (see *Migrations* below) — which
works, but has no version history.

---

## The core fix

**Before:** `POST /api/reservations` validated four fields and inserted. No
availability query, no transaction, no lock. Two staff booking the same room for
the same nights both succeeded, every time. The public engine checked
availability over HTTP against a *different database* — a race no transaction
could cover. The one real capacity check (`POST /api/holds`) was dead code that
nothing called; holds were actually created by a Redis subscriber that never
compared against `totalInventory`.

**After:** inventory is the single authoritative capacity gate.

```
reservation                    inventory
     │                              │
     ├─ POST /api/holds ───────────►│  BEGIN
     │                              │    SELECT … FROM "RoomType"
     │                              │      WHERE code = $1 FOR UPDATE   ← serializes
     │                              │    count holds per night in range
     │                              │    if any night full → 409, ROLLBACK
     │                              │    INSERT one row per night
     │◄──────── 201 { groupId } ────┤  COMMIT
     │
     ├─ INSERT reservation          │        ← fails? release the hold, delete the row
     │
     ├─ POST /holds/:g/attach ─────►│  bind reservationId, extend expiry to checkout
```

`SELECT … FOR UPDATE` is the **first** statement in the transaction, so every
concurrent booking of that room type queues on one row lock. This is the only
place in the codebase using `$queryRaw` — Prisma has no row-lock API — and it's a
parameterised tagged template, not string concatenation.

A hold is claimed *before* the reservation exists, so it starts unattached with a
120-second TTL. If the insert fails, the hold is released immediately; if the
process dies, it expires on its own. Worst case is a brief phantom hold, never an
oversell.

---

## What changed

### Capacity
- `services/inventory/src/routes/inventory.routes.js` — holds rewritten: range-based
  (one row per night, shared `groupId`), row-locked, hard block at `totalInventory`,
  plus `attach` / `release` / `commit` group lifecycle. A booking is refused if
  **any single night** in its range is full.
- `services/inventory/src/subscribers/redis.subscriber.js` — **no longer creates
  holds.** Now warns if a reservation arrives without one.
- `services/reservation/src/routes/reservation.routes.js` and `src/index.js` —
  both booking paths claim capacity before inserting; a date change re-holds the
  new range and releases the old; cancel releases the hold directly rather than
  trusting fire-and-forget pub/sub.

### Room assignment
- `services/stay/src/routes/stay.routes.js` — new `validateRoomAssignment()`
  applied to check-in, walk-in and room-change. Verifies server-side that the
  room exists, is habitable, and isn't already occupied. Fails **closed** if
  inventory is unreachable.

### Dates
- `services/_shared/date.js` (new) — two explicit conventions: local business days
  (`localDay`, `startOfLocalDay`, `parseLocalDay`) and UTC date-only keys
  (`utcDayStart`, `eachNight`, `utcDayKey`). Mixing them is what put reservation
  and audit 8 hours out of phase.
- `services/audit/src/routes/audit.routes.js` — guest-visible folio lines and EOD
  totals no longer report the previous day; `?from=` no longer excludes its own
  business day; no-shows are caught on the right night instead of a day late.

### Reliability
- `services/_shared/serviceCall.js` (new) — every inter-service call now has an
  `AbortSignal` timeout and bounded retry. Node's `fetch` has no default timeout,
  and reservation→inventory is now on the critical booking path.
- Missing `redis.on('error')` listeners added in inventory and stay — an unhandled
  ioredis error event kills the process, which for inventory means the capacity
  gate disappears.
- `connection_limit=20` on inventory and reservation, since lock-queued
  transactions hold pooled connections.

### Schema and constraints
- Indexes on every hot path: `Reservation(checkIn, status)`, `InventoryHold`
  (had **none**), `Stay` (had **none**), `FolioTransaction(folioId, postedAt)`,
  `Payment(folioId)`. Explicit `onDelete` on all relations.
- Database-level backstops in raw SQL (Prisma can't express these):
  - `Reservation` — `EXCLUDE USING gist` preventing overlapping dates on one
    physical room
  - `Stay` — partial unique index: one `IN_HOUSE` guest per room
  - `InventoryHold` — unique `(groupId, date)`; `FacilityBooking` — no overlaps
  - `CHECK` constraints on counts, money and date ordering

### Tests — 212 passing
- `services/_shared/date.test.js` — 30 tests, run under `TZ=Asia/Manila` because
  these bugs are invisible in UTC
- `services/inventory/src/routes/holds.test.js` — 26 tests including a 20-way
  stampede, **plus a regression detector** that re-runs the same race with the
  lock removed and asserts it *does* oversell. Without that control, "1 winner"
  could just mean the test was too slow to race.
- `services/stay/src/routes/roomAssignment.test.js` — 18 tests
- `services/reservation/src/routes/reservation.test.js` — extended to 11

Also: added a `test` script to all 9 services (8 had none, so CI's
`npm test --if-present` silently skipped them — including the reservation test
that already existed and had rotted into failing), pinned CI to ESLint 8 (v9
ignores `.eslintrc.json`, so that job could never pass), removed 9 unused `cors`
imports that broke `--max-warnings=0`, and excluded the 2 GB of committed Vite
build output from linting.

---

## Migrations

`prisma db push` diffs the schema and will **drop** raw-SQL constraints it doesn't
know about — so the constraints above were at risk on every schema change. But
`migrate deploy` needs a committed baseline, and generating one requires network
access for Prisma's engine download.

`scripts/db-init.sh` (now each service's startup command) handles both: it uses
`migrate deploy` when a baseline exists, `db push` otherwise, and **always**
re-applies the raw-SQL constraint files afterwards. Every constraint file is
idempotent, so this repairs anything `db push` removed.

If a constraint fails to apply, real data violates it. Each `migration.sql`
contains the diagnostic query to find the offending rows — deliberately, because
those rows are corruption from the pre-fix code and need a decision, not a silent
`DELETE`.

---

## Known gaps

Found during review, deliberately left for later:

1. **`POST /api/stays/:id/extend` doesn't claim the added nights.** Moving a
   checkout date later bypasses the hold system. Real oversell vector — worth
   doing before Phase 2.
2. **Walk-ins don't hold room-type capacity.** Physical-room exclusivity *is*
   enforced, so a walk-in can't take an occupied room, but it isn't subtracted
   from future availability.
3. **`commitHold` is never called.** Check-in leaves holds `ACTIVE` rather than
   `COMMITTED`, so the "a sold room can't be put back on the market" guard never
   engages.
4. **No sweeper for expired holds.** They stop counting (every query filters
   `expiresAt > now`) but the rows accumulate.
5. **`GET /availability/find-room` auto-assign is type-level only** — it can
   suggest a physical room already assigned to another booking. That now returns a
   clean 409 from the exclusion constraint rather than double-booking, but the
   wizard should pre-filter.

Everything else from the audit — the Vite dev server in production, seeded admin
credentials, the ~6-user rate-limit ceiling, the 3D room, the mini-games — is
untouched and still in `InnSight_Technical_Findings.md`.
