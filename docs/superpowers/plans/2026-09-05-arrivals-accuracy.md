# Arrivals Accuracy & Today/Week/Month Check-In — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the expected-arrivals list always show every confirmed reservation due to arrive, and let the front desk switch between Today / Week / Month and check a guest in from any of them.

**Architecture:** `/api/arrivals` stops reading the lossy `Stay` projection and reads confirmed reservations from the reservation service instead, left-joined against local `Stay` rows. The reservation supplies *who is expected*; the local `Stay` row supplies *whether they have already arrived*. A new pure `arrivalsWindow()` helper resolves `range` into a date window, and `reservationListWhere` gains `checkInFrom`/`checkInTo` params that are distinct from the existing overlap window.

**Tech Stack:** Node 20, Express 4, Prisma 6, `node:test` + `node:assert`, React 18.

**Spec:** `docs/superpowers/specs/2026-09-05-folio-arrivals-room-editor-design.md` §2

## Global Constraints

- **`from`/`to` on `GET /api/reservations` is an OVERLAP filter and must not change meaning.** `services/audit` calls it with `to` and no `from` to sweep for no-shows, and the calendar depends on the overlap semantics. The existing tests at `services/reservation/src/routes/reservation.test.js:527-621` are the regression gate and must keep passing untouched.
- **`Reservation.checkIn` is written as UTC midnight** (`new Date('YYYY-MM-DD')`, `reservation.routes.js:134`) — Convention 2 in `services/_shared/date.js`. All arrival window arithmetic uses `utcDayStart`/`utcDayFromString`/`utcDayKey`, **never** `localDayBounds` and never `toISOString().slice(0,10)` on a locally-built Date.
- **The local `Stay` row is authoritative for "has this guest arrived", not the reservation status.** `Reservation.status = CHECKED_IN` is set by a Redis subscriber (`services/reservation/src/subscribers/redis.subscriber.js:38`) and is therefore just as lossy as the `Stay` projection this work is replacing. `POST /api/check-in` writes the `Stay` row synchronously, so the join is load-bearing — it is what stops an already-in-house guest reappearing as an expected arrival after a Redis outage.
- Statuses spelled exactly: `CANCELLED` (double L), `PRE_ARRIVAL`, `IN_HOUSE`, `DEPARTED`, `NO_SHOW`, `CONFIRMED`, `CHECKED_IN`.
- Tests are colocated `*.test.js` files run by `node --test`. Use `require('node:test')` and `require('node:assert')`.
- `services/_shared/*.js` is vendored byte-identically into each service's `src/lib/`. Edit `_shared` first, copy to every service, and `bash scripts/check-shared.sh` must exit 0.
- Do not change `/api/departures`. It reads `IN_HOUSE` stays with a real `expectedCheckOut` timestamp and has no equivalent blind spot.
- Gateway routing is unchanged: `/api/arrivals` already proxies to the stay service (`services/gateway/nginx.conf:289`). No gateway rebuild in this plan.

---

### Task 1: `checkInFrom` / `checkInTo` on the reservation list filter

**Files:**
- Modify: `services/reservation/src/lib/listQuery.js:58-76`
- Test: `services/reservation/src/lib/listQuery.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `reservationListWhere({ status, guestId, assignedRoomId, from, to, checkInFrom, checkInTo, q })` → Prisma `where` object. `checkInFrom` is inclusive (`gte`), `checkInTo` is exclusive (`lt`). Both accept `'YYYY-MM-DD'` or a full ISO timestamp and throw `BadWindowError` when unparseable. Task 3 calls this endpoint over HTTP with these query params.

- [ ] **Step 1: Write the failing tests**

Create `services/reservation/src/lib/listQuery.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { reservationListWhere, BadWindowError } = require('./listQuery');

// ─────────────────────────────────────────────────────────────────────────────
// `from`/`to` are an OVERLAP window: "which bookings touch these nights?".
// `checkInFrom`/`checkInTo` ask a DIFFERENT question: "which bookings START in
// this window?" — what an arrivals list needs. They are separate params because
// the audit's no-show sweep and the calendar both depend on the overlap
// semantics of from/to, and reinterpreting those would break them.
// ─────────────────────────────────────────────────────────────────────────────

test('checkInFrom sets an inclusive lower bound on checkIn', () => {
  const where = reservationListWhere({ checkInFrom: '2026-09-05' });
  assert.deepEqual(where.checkIn, { gte: new Date('2026-09-05T00:00:00.000Z') });
  assert.equal(where.checkOut, undefined, 'an arrival window must not constrain checkOut');
});

test('checkInTo sets an exclusive upper bound on checkIn', () => {
  const where = reservationListWhere({ checkInTo: '2026-09-06' });
  assert.deepEqual(where.checkIn, { lt: new Date('2026-09-06T00:00:00.000Z') });
});

test('checkInFrom and checkInTo combine into one bounded range', () => {
  const where = reservationListWhere({ checkInFrom: '2026-09-05', checkInTo: '2026-09-12' });
  assert.deepEqual(where.checkIn, {
    gte: new Date('2026-09-05T00:00:00.000Z'),
    lt: new Date('2026-09-12T00:00:00.000Z'),
  });
});

// The bug this guards: `to` used to ASSIGN where.checkIn outright. Adding a
// second writer to the same key without merging silently drops one bound, and
// the caller gets a wider result set than it asked for with no error.
test('the overlap `to` and an arrival window MERGE rather than overwrite', () => {
  const where = reservationListWhere({ from: '2026-09-01', to: '2026-09-30', checkInFrom: '2026-09-05' });
  assert.equal(
    where.checkIn.gte.toISOString(),
    '2026-09-05T00:00:00.000Z',
    'checkInFrom must survive alongside to'
  );
  assert.equal(
    where.checkIn.lt.toISOString(),
    '2026-09-30T00:00:00.000Z',
    'to must survive alongside checkInFrom'
  );
  assert.deepEqual(where.checkOut, { gt: new Date('2026-09-01T00:00:00.000Z') });
});

test('when both cap checkIn, the TIGHTER upper bound wins', () => {
  const where = reservationListWhere({ to: '2026-09-30', checkInTo: '2026-09-08' });
  assert.equal(where.checkIn.lt.toISOString(), '2026-09-08T00:00:00.000Z');

  const other = reservationListWhere({ to: '2026-09-08', checkInTo: '2026-09-30' });
  assert.equal(other.checkIn.lt.toISOString(), '2026-09-08T00:00:00.000Z');
});

test('no date params leaves checkIn unconstrained', () => {
  const where = reservationListWhere({ status: 'CONFIRMED' });
  assert.equal(where.checkIn, undefined);
  assert.equal(where.status, 'CONFIRMED');
});

test('an unparseable arrival bound throws BadWindowError, not a silent empty list', () => {
  assert.throws(() => reservationListWhere({ checkInFrom: 'not-a-date' }), BadWindowError);
  assert.throws(() => reservationListWhere({ checkInTo: 'not-a-date' }), BadWindowError);
});

// ── The existing overlap behaviour must be untouched ────────────────────────

test('from/to still build the overlap test', () => {
  const where = reservationListWhere({ from: '2026-09-05', to: '2026-09-08' });
  assert.deepEqual(where.checkIn, { lt: new Date('2026-09-08T00:00:00.000Z') });
  assert.deepEqual(where.checkOut, { gt: new Date('2026-09-05T00:00:00.000Z') });
});

test('the audit no-show sweep form (to with no from) still works', () => {
  const where = reservationListWhere({ status: 'CONFIRMED', to: '2026-09-05T00:00:00.000Z' });
  assert.deepEqual(where.checkIn, { lt: new Date('2026-09-05T00:00:00.000Z') });
  assert.equal(where.checkOut, undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/reservation" && node --test src/lib/listQuery.test.js
```

Expected: the four `checkInFrom`/`checkInTo`/merge/tighter tests FAIL (`where.checkIn` is `undefined`, because the params are ignored today). The three "existing behaviour" tests and the "no date params" test PASS already — that is intended, they are the regression gate.

- [ ] **Step 3: Implement the merged checkIn window**

In `services/reservation/src/lib/listQuery.js`, replace the body of `reservationListWhere` (currently lines 58-76). Add the two params to the destructure and replace the single `if (to)` line with the merging block:

```js
function reservationListWhere({
  status,
  guestId,
  assignedRoomId,
  from,
  to,
  checkInFrom,
  checkInTo,
  q,
} = {}) {
  const where = {};
  if (status) where.status = status;
  if (guestId) where.guestId = guestId;
  // Housekeeping has always sent this filter and the route silently dropped it,
  // so "which booking is in room 412?" was answered with every booking in the
  // hotel and the caller picked the first plausible-looking one.
  if (assignedRoomId) where.assignedRoomId = assignedRoomId;

  // THREE params write to `where.checkIn`, so they must MERGE into one object.
  // `to` used to assign it outright; a second writer added naively would have
  // silently dropped a bound, and the caller would get a WIDER result set than
  // it asked for with nothing reporting it.
  //
  // `from`/`to` are the overlap window (see the header comment).
  // `checkInFrom`/`checkInTo` are the arrivals window — "which bookings START
  // here" — deliberately separate so the audit's no-show sweep and the calendar
  // keep the overlap semantics they depend on.
  const checkIn = {};
  if (to) checkIn.lt = parseBound(to, 'to');
  if (checkInFrom) checkIn.gte = parseBound(checkInFrom, 'checkInFrom');
  if (checkInTo) {
    const bound = parseBound(checkInTo, 'checkInTo');
    // The TIGHTER upper bound wins, so combining the two windows narrows the
    // result rather than widening it. A filter that widens when you add a
    // constraint is the kind of bug nobody reads back off a screen.
    checkIn.lt = checkIn.lt && checkIn.lt < bound ? checkIn.lt : bound;
  }
  if (Object.keys(checkIn).length > 0) where.checkIn = checkIn;

  if (from) where.checkOut = { gt: parseBound(from, 'from') };
  if (q) {
    where.OR = [
      { confirmationNumber: { contains: q, mode: 'insensitive' } },
      { guestName: { contains: q, mode: 'insensitive' } },
      { guestEmail: { contains: q, mode: 'insensitive' } },
    ];
  }
  return where;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/reservation" && node --test src/lib/listQuery.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Run the whole reservation suite — the overlap regression gate**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/reservation" && npm test
```

Expected: all tests PASS, including the overlap suite at `src/routes/reservation.test.js:527-621`. If any overlap test fails, the merge logic is wrong — fix it rather than changing the test. Those tests encode a bug that was already fixed once.

- [ ] **Step 6: Commit**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
git add services/reservation/src/lib/listQuery.js services/reservation/src/lib/listQuery.test.js
git commit -m "$(cat <<'EOF'
feat: add checkInFrom/checkInTo arrival window to the reservation list filter

An arrivals list asks "which bookings START in this window", which is not
the overlap question from/to answers. Adding separate params keeps the
overlap semantics the calendar and the audit's no-show sweep depend on.

All three date params write to where.checkIn, so they merge into one object
and the tighter upper bound wins -- assigning outright, as `to` used to,
would silently drop a bound and widen the result set.

EOF
)"
```

---

### Task 2: The `arrivalsWindow()` range helper

**Files:**
- Create: `services/stay/src/lib/arrivalsWindow.js`
- Test: `services/stay/src/lib/arrivalsWindow.test.js` (create)

**Interfaces:**
- Consumes: `utcDayStart`, `utcDayKey` from `services/stay/src/lib/date.js` (already vendored).
- Produces: `arrivalsWindow(range, now)` → `{ range, checkInFrom, checkInTo, overdueBefore }` where all three date fields are `'YYYY-MM-DD'` strings. `range` is the normalised range actually used. Task 3 consumes this.

This helper is deliberately pure and service-local — it is not `_shared`, because only the stay service asks this question.

- [ ] **Step 1: Write the failing tests**

Create `services/stay/src/lib/arrivalsWindow.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { arrivalsWindow, ARRIVAL_RANGES } = require('./arrivalsWindow');

// A fixed "now" so these tests do not drift. Deliberately late in the LOCAL day
// for a UTC+8 property: 2026-09-05T23:30+08:00 is 2026-09-05T15:30Z. Reservation
// checkIn values are UTC midnight (Convention 2 in lib/date.js), so the window
// must be built from the UTC calendar day, and must NOT roll over just because
// the local clock is near midnight.
const NOW = new Date('2026-09-05T15:30:00.000Z');

test('today is a single UTC day, upper bound exclusive', () => {
  const w = arrivalsWindow('today', NOW);
  assert.equal(w.checkInFrom, '2026-09-05');
  assert.equal(w.checkInTo, '2026-09-06');
});

test('week is a rolling 7 days from today', () => {
  const w = arrivalsWindow('week', NOW);
  assert.equal(w.checkInFrom, '2026-09-05');
  assert.equal(w.checkInTo, '2026-09-12');
});

test('month is a rolling 30 days from today', () => {
  const w = arrivalsWindow('month', NOW);
  assert.equal(w.checkInFrom, '2026-09-05');
  assert.equal(w.checkInTo, '2026-10-05');
});

// Overdue is the same for every range: anything due before today that never
// arrived. This is what stopped a guest who was due yesterday from vanishing
// off the desk's screen entirely instead of demanding action.
test('overdueBefore is today for every range', () => {
  for (const r of ARRIVAL_RANGES) {
    assert.equal(arrivalsWindow(r, NOW).overdueBefore, '2026-09-05', `range ${r}`);
  }
});

test('an unknown or missing range falls back to today', () => {
  assert.equal(arrivalsWindow(undefined, NOW).range, 'today');
  assert.equal(arrivalsWindow('', NOW).range, 'today');
  assert.equal(arrivalsWindow('fortnight', NOW).range, 'today');
  assert.equal(arrivalsWindow('fortnight', NOW).checkInTo, '2026-09-06');
});

test('range is normalised case-insensitively', () => {
  assert.equal(arrivalsWindow('WEEK', NOW).range, 'week');
  assert.equal(arrivalsWindow('Month', NOW).checkInTo, '2026-10-05');
});

// Crossing a month boundary is where naive date arithmetic breaks.
test('a rolling window crosses month and year boundaries correctly', () => {
  const w = arrivalsWindow('week', new Date('2026-12-29T02:00:00.000Z'));
  assert.equal(w.checkInFrom, '2026-12-29');
  assert.equal(w.checkInTo, '2027-01-05');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/stay" && node --test src/lib/arrivalsWindow.test.js
```

Expected: FAIL — `Cannot find module './arrivalsWindow'`.

- [ ] **Step 3: Implement the helper**

Create `services/stay/src/lib/arrivalsWindow.js`:

```js
// Resolves an arrivals range ('today' | 'week' | 'month') into the date window
// the reservation service is queried with.
//
// WHY UTC DAYS, NOT LOCAL DAYS
// ---------------------------
// Reservation.checkIn is written as `new Date('YYYY-MM-DD')` — UTC midnight,
// Convention 2 in lib/date.js. The arrivals endpoint used to compare those
// values against localDayBounds(), mixing the two conventions that file
// explicitly warns about. It happens not to misfire at UTC+8 because the offset
// is positive, but it is wrong in principle and breaks outright west of
// Greenwich. Build the window in the same convention the values are stored in.
//
// WHY ROLLING WINDOWS
// -------------------
// 'week' is the next 7 days, not "until Sunday". The desk's question is "who is
// coming in the next week", and a calendar week answers that with one day of
// data on a Saturday.

const { utcDayStart, utcDayKey } = require('./date');

const ARRIVAL_RANGES = ['today', 'week', 'month'];

const SPAN_DAYS = { today: 1, week: 7, month: 30 };

// Adding whole days in MILLISECONDS rather than with setDate(), so the
// arithmetic stays in UTC. setDate() reads and writes LOCAL calendar fields,
// which on a UTC-midnight value in a UTC+8 container reads as the previous day
// and lands the result one day early.
const DAY_MS = 86400000;

function arrivalsWindow(range, now = new Date()) {
  const normalised = String(range || '').toLowerCase();
  const resolved = ARRIVAL_RANGES.includes(normalised) ? normalised : 'today';

  const start = utcDayStart(now);
  const end = new Date(start.getTime() + SPAN_DAYS[resolved] * DAY_MS);

  return {
    range: resolved,
    checkInFrom: utcDayKey(start),
    checkInTo: utcDayKey(end),
    // Anything due before today and still not arrived. Same for every range —
    // an overdue arrival is a problem the desk must see whichever view is open.
    overdueBefore: utcDayKey(start),
  };
}

module.exports = { arrivalsWindow, ARRIVAL_RANGES };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/stay" && node --test src/lib/arrivalsWindow.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
git add services/stay/src/lib/arrivalsWindow.js services/stay/src/lib/arrivalsWindow.test.js
git commit -m "$(cat <<'EOF'
feat: add arrivalsWindow() to resolve today/week/month into a UTC date window

Built in the UTC day convention Reservation.checkIn is stored in, not the
local one the old arrivals query used -- mixing those two conventions is the
bug lib/date.js exists to warn about.

Week and month are rolling windows, not calendar ones: "who is coming in the
next 7 days" is the desk's question, and a calendar week answers it with one
day of data on a Saturday.

EOF
)"
```

---

### Task 3: Rebuild `GET /api/arrivals` on reservations

**Files:**
- Modify: `services/stay/src/routes/stay.routes.js:110-126` (the `/arrivals` route)
- Test: `services/stay/src/routes/arrivals.test.js` (create)

**Interfaces:**
- Consumes: `arrivalsWindow(range, now)` from Task 2; `reservationCall` and `RESERVATION_URL`, both already declared at `stay.routes.js:19,26`; `GET /api/reservations?status=CONFIRMED&checkInFrom=&checkInTo=` from Task 1.
- Produces: `GET /api/arrivals?range=today|week|month` **and** `GET /api/arrivals?date=YYYY-MM-DD` → `{ range, degraded, arrivals: [...] }`.

  **This is a breaking shape change** — the route currently returns a bare array. There are **four** consumers, updated in Task 4 (`web/src/pages/Arrivals.jsx`) and Task 5 (`Dashboard.jsx`, the audit service, the reports service).

  **`?date=` MUST be preserved.** The night audit's `movements_snapshot` step (`services/audit/src/routes/audit.routes.js:257`) and `GET /api/reports/arrivals` (`services/reports/src/routes/reports.routes.js:132`) both call `/api/arrivals?date=`. Dropping the param would make the audit record a wrong arrival count for every business day. Semantics:

  | Query | Window | Overdue rows |
  |---|---|---|
  | `?date=YYYY-MM-DD` | exactly that UTC day | **excluded** |
  | `?range=today\|week\|month` | rolling from today | included |
  | neither | today | included |

  `date` wins over `range` when both are sent. `range` is `null` in the response when `date` was used. Overdue rows are excluded from `?date=` because the audit asks a bounded historical question — "who was due on day X" — and injecting rows from other days would inflate its count.

  **Expected behaviour change for the audit:** arrival counts may rise, because reservations that never got a `Stay` row now appear. That is the bug being fixed, not a regression. The old route's exclusion of already-checked-in guests is preserved exactly, so counts stay otherwise comparable.

  Each arrival row: `{ id, stayId, reservationId, guestId, guestName, confirmationNumber, expectedCheckIn, expectedCheckOut, nights, adults, children, roomTypeCode, status, overdue }`. `id` is the stay id when a stay row exists, otherwise the reservation id prefixed `res:` — the React list needs a stable key and a reservation with no stay has no stay id.

- [ ] **Step 1: Write the failing tests**

Create `services/stay/src/routes/arrivals.test.js`. This follows the in-memory-Prisma + real-HTTP harness already established in `services/stay/src/routes/roomAssignment.test.js`:

```js
// Tests for GET /api/arrivals.
//
// THE BUG THIS FILE EXISTS FOR
// ----------------------------
// /api/arrivals used to read Stay rows with status PRE_ARRIVAL. Those rows are
// created ONLY by a reservation:confirmed Redis message
// (subscribers/redis.subscriber.js). A reservation confirmed while this service
// was down, or seeded directly, got no Stay row and was PERMANENTLY invisible to
// the front desk -- with no reconciliation anywhere. The first test below fails
// against the old implementation and is the regression gate.
//
//   node --test src/routes/arrivals.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// ── In-memory stay store ────────────────────────────────────────────────────

const memDb = { stay: new Map() };
let seq = 0;

function matches(row, where = {}) {
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v && row[k] === v.not) return false;
      if ('in' in v && !v.in.includes(row[k])) return false;
      if ('notIn' in v && v.notIn.includes(row[k])) return false;
      if ('gte' in v && !(row[k] >= v.gte)) return false;
      if ('lt' in v && !(row[k] < v.lt)) return false;
    } else if (row[k] !== v) {
      return false;
    }
  }
  return true;
}

const mockPrisma = {
  stay: {
    create: async ({ data }) => {
      const id = `s${(seq += 1)}`;
      const row = { id, status: 'PRE_ARRIVAL', ...data };
      memDb.stay.set(id, row);
      return row;
    },
    findMany: async ({ where } = {}) => [...memDb.stay.values()].filter((r) => matches(r, where || {})),
    findFirst: async ({ where }) => [...memDb.stay.values()].find((r) => matches(r, where)) || null,
    findUnique: async ({ where: { id } }) => memDb.stay.get(id) || null,
    update: async ({ where: { id }, data }) => {
      const row = { ...memDb.stay.get(id), ...data };
      memDb.stay.set(id, row);
      return row;
    },
    updateMany: async () => ({ count: 0 }),
    count: async ({ where } = {}) => [...memDb.stay.values()].filter((r) => matches(r, where || {})).length,
  },
  checkInTask: {
    create: async ({ data }) => data,
    findFirst: async () => null,
    findMany: async () => [],
    update: async ({ data }) => data,
  },
  $transaction: async (fn) => fn(mockPrisma),
};

// ── Stubs, installed before the route module loads ──────────────────────────

// stay.routes.js requires pdfkit at module scope for the registration card.
// Intercepted at the loader because require.resolve() throws when the module is
// genuinely absent from the test environment.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pdfkit') {
    return function PDFDocumentStub() {
      return {
        pipe() {}, fontSize() { return this; }, text() { return this; },
        moveDown() { return this; }, end() {},
      };
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

require.cache[require.resolve('@prisma/client')] = {
  exports: { PrismaClient: function () { return mockPrisma; } },
};
require.cache[require.resolve('ioredis')] = {
  exports: function () { return { publish: () => {}, on: () => {}, disconnect: () => {} }; },
};
require.cache[require.resolve('../middleware/auth')] = {
  exports: {
    ROLE_GROUPS: new Proxy({}, { get: () => ['ADMIN'] }),
    verifyToken: (req, _res, next) => { req.user = { sub: 'u1', roles: ['ADMIN'] }; next(); },
    requireRole: () => (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    JWT_SECRET: 'test-secret-that-is-at-least-32-chars-long',
  },
};
require.cache[require.resolve('../lib/inventoryClient')] = {
  exports: {
    NoInventoryError: class extends Error {},
    makeInventoryClient: () => ({
      getRoom: async () => null, acquireHold: async () => ({ groupId: 'g1' }),
      attachHold: async () => ({}), releaseHold: async () => true, commitHold: async () => ({}),
    }),
  },
};

// The reservation service's answers, and whether it is reachable at all.
let reservations = [];
let reservationReachable = true;
let lastReservationQuery = null;

require.cache[require.resolve('../lib/serviceCall')] = {
  exports: {
    ServiceCallError: class extends Error {},
    makeServiceCaller: () => ({
      call: async (url) => {
        if (!reservationReachable) throw new Error('ECONNREFUSED');
        lastReservationQuery = new URL(url, 'http://x').searchParams;
        const from = lastReservationQuery.get('checkInFrom');
        const to = lastReservationQuery.get('checkInTo');
        return reservations.filter((r) => {
          const day = r.checkIn.slice(0, 10);
          // The route may ask for the overdue slice (no lower bound) or the
          // in-range slice; honour whichever bounds were sent.
          if (from && day < from) return false;
          if (to && day >= to) return false;
          return true;
        });
      },
    }),
  },
};

const router = require('./stay.routes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

function call(app, method, path, body) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const data = body ? JSON.stringify(body) : null;
      const req = http.request(
        { host: '127.0.0.1', port, method, path,
          headers: { 'Content-Type': 'application/json', ...(data && { 'Content-Length': Buffer.byteLength(data) }) } },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); });
        }
      );
      if (data) req.write(data);
      req.end();
    });
  });
}

// Today, as the UTC day key the route builds its window from.
const TODAY = new Date().toISOString().slice(0, 10);
function dayOffset(n) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

function reset() {
  memDb.stay.clear();
  seq = 0;
  reservations = [];
  reservationReachable = true;
  lastReservationQuery = null;
}

// ── The regression gate ─────────────────────────────────────────────────────

test('a CONFIRMED reservation with NO Stay row still appears in arrivals', async () => {
  reset();
  reservations = [{
    id: 'r1', status: 'CONFIRMED', guestId: 'g1', guestName: 'Jana Felismino',
    confirmationNumber: 'CN-1001', checkIn: `${TODAY}T00:00:00.000Z`,
    checkOut: `${dayOffset(3)}T00:00:00.000Z`, adults: 2, children: 1, roomTypeCode: 'DLX',
  }];
  // Deliberately NO stay row -- this is a reservation whose reservation:confirmed
  // event was never delivered.
  const res = await call(makeApp(), 'GET', '/api/arrivals', null);
  assert.equal(res.status, 200);
  assert.equal(res.body.arrivals.length, 1, 'a confirmed reservation must be visible without a Stay row');
  assert.equal(res.body.arrivals[0].reservationId, 'r1');
  assert.equal(res.body.arrivals[0].guestName, 'Jana Felismino');
  assert.equal(res.body.arrivals[0].confirmationNumber, 'CN-1001');
  assert.equal(res.body.arrivals[0].stayId, null, 'no stay row exists yet');
  assert.ok(res.body.arrivals[0].id, 'every row needs a stable key for React');
});

test('a reservation whose stay is already IN_HOUSE does not appear', async () => {
  reset();
  reservations = [{
    id: 'r1', status: 'CONFIRMED', guestId: 'g1', guestName: 'Jana Felismino',
    confirmationNumber: 'CN-1001', checkIn: `${TODAY}T00:00:00.000Z`,
    checkOut: `${dayOffset(3)}T00:00:00.000Z`, adults: 1, children: 0, roomTypeCode: 'DLX',
  }];
  // The Stay row is authoritative for "have they arrived". Reservation.status is
  // set by a Redis subscriber and is just as lossy as the projection this route
  // stopped reading -- so an in-house guest must be excluded by the JOIN, not by
  // trusting the reservation to have been updated.
  await mockPrisma.stay.create({ data: { reservationId: 'r1', status: 'IN_HOUSE', guestName: 'Jana Felismino' } });
  const res = await call(makeApp(), 'GET', '/api/arrivals', null);
  assert.deepEqual(res.body.arrivals, []);
});

test('a DEPARTED or NO_SHOW stay does not reappear as an arrival', async () => {
  for (const status of ['DEPARTED', 'NO_SHOW']) {
    reset();
    reservations = [{
      id: 'r1', status: 'CONFIRMED', guestId: 'g1', guestName: 'X', confirmationNumber: 'CN-1',
      checkIn: `${TODAY}T00:00:00.000Z`, checkOut: `${dayOffset(1)}T00:00:00.000Z`,
      adults: 1, children: 0, roomTypeCode: 'STD',
    }];
    await mockPrisma.stay.create({ data: { reservationId: 'r1', status, guestName: 'X' } });
    const res = await call(makeApp(), 'GET', '/api/arrivals', null);
    assert.deepEqual(res.body.arrivals, [], `${status} must not appear`);
  }
});

test('an existing PRE_ARRIVAL stay is joined, and supplies stayId', async () => {
  reset();
  reservations = [{
    id: 'r1', status: 'CONFIRMED', guestId: 'g1', guestName: 'Jana', confirmationNumber: 'CN-1',
    checkIn: `${TODAY}T00:00:00.000Z`, checkOut: `${dayOffset(2)}T00:00:00.000Z`,
    adults: 1, children: 0, roomTypeCode: 'STD',
  }];
  const stay = await mockPrisma.stay.create({ data: { reservationId: 'r1', status: 'PRE_ARRIVAL', guestName: 'Jana' } });
  const res = await call(makeApp(), 'GET', '/api/arrivals', null);
  assert.equal(res.body.arrivals.length, 1);
  assert.equal(res.body.arrivals[0].stayId, stay.id);
  assert.equal(res.body.arrivals[0].id, stay.id);
});

// ── Ranges ──────────────────────────────────────────────────────────────────

test('range=today excludes an arrival due next week; range=week includes it', async () => {
  reset();
  reservations = [{
    id: 'r2', status: 'CONFIRMED', guestId: 'g2', guestName: 'Later Guest', confirmationNumber: 'CN-2',
    checkIn: `${dayOffset(4)}T00:00:00.000Z`, checkOut: `${dayOffset(6)}T00:00:00.000Z`,
    adults: 1, children: 0, roomTypeCode: 'STD',
  }];
  const today = await call(makeApp(), 'GET', '/api/arrivals?range=today', null);
  assert.deepEqual(today.body.arrivals, []);
  assert.equal(today.body.range, 'today');

  const week = await call(makeApp(), 'GET', '/api/arrivals?range=week', null);
  assert.equal(week.body.arrivals.length, 1);
  assert.equal(week.body.range, 'week');
});

test('range=month includes an arrival three weeks out', async () => {
  reset();
  reservations = [{
    id: 'r3', status: 'CONFIRMED', guestId: 'g3', guestName: 'Far Guest', confirmationNumber: 'CN-3',
    checkIn: `${dayOffset(21)}T00:00:00.000Z`, checkOut: `${dayOffset(23)}T00:00:00.000Z`,
    adults: 1, children: 0, roomTypeCode: 'STD',
  }];
  const res = await call(makeApp(), 'GET', '/api/arrivals?range=month', null);
  assert.equal(res.body.arrivals.length, 1);
});

// ── Overdue ─────────────────────────────────────────────────────────────────

test('an overdue arrival appears in ALL THREE ranges, flagged overdue', async () => {
  for (const range of ['today', 'week', 'month']) {
    reset();
    reservations = [{
      id: 'r4', status: 'CONFIRMED', guestId: 'g4', guestName: 'Yesterday Guest', confirmationNumber: 'CN-4',
      checkIn: `${dayOffset(-1)}T00:00:00.000Z`, checkOut: `${dayOffset(1)}T00:00:00.000Z`,
      adults: 1, children: 0, roomTypeCode: 'STD',
    }];
    const res = await call(makeApp(), 'GET', `/api/arrivals?range=${range}`, null);
    assert.equal(res.body.arrivals.length, 1, `overdue must show in range=${range}`);
    assert.equal(res.body.arrivals[0].overdue, true);
  }
});

test('overdue rows sort before in-range rows', async () => {
  reset();
  reservations = [
    { id: 'today1', status: 'CONFIRMED', guestId: 'g5', guestName: 'Today Guest', confirmationNumber: 'CN-5',
      checkIn: `${TODAY}T00:00:00.000Z`, checkOut: `${dayOffset(1)}T00:00:00.000Z`, adults: 1, children: 0, roomTypeCode: 'STD' },
    { id: 'late1', status: 'CONFIRMED', guestId: 'g6', guestName: 'Overdue Guest', confirmationNumber: 'CN-6',
      checkIn: `${dayOffset(-2)}T00:00:00.000Z`, checkOut: `${dayOffset(1)}T00:00:00.000Z`, adults: 1, children: 0, roomTypeCode: 'STD' },
  ];
  const res = await call(makeApp(), 'GET', '/api/arrivals?range=today', null);
  assert.equal(res.body.arrivals.length, 2);
  assert.equal(res.body.arrivals[0].reservationId, 'late1', 'the overdue guest is the one needing action');
  assert.equal(res.body.arrivals[1].reservationId, 'today1');
});

// ── ?date= — the night audit's and reports service's form ───────────────────

test('?date= returns exactly that day, with NO overdue rows', async () => {
  reset();
  reservations = [
    { id: 'onday', status: 'CONFIRMED', guestId: 'g7', guestName: 'On The Day', confirmationNumber: 'CN-7',
      checkIn: `${TODAY}T00:00:00.000Z`, checkOut: `${dayOffset(1)}T00:00:00.000Z`, adults: 1, children: 0, roomTypeCode: 'STD' },
    { id: 'earlier', status: 'CONFIRMED', guestId: 'g8', guestName: 'Days Ago', confirmationNumber: 'CN-8',
      checkIn: `${dayOffset(-3)}T00:00:00.000Z`, checkOut: `${dayOffset(1)}T00:00:00.000Z`, adults: 1, children: 0, roomTypeCode: 'STD' },
  ];
  const res = await call(makeApp(), 'GET', `/api/arrivals?date=${TODAY}`, null);
  assert.equal(res.status, 200);
  assert.equal(res.body.arrivals.length, 1, 'the audit asks a bounded question -- other days must not leak in');
  assert.equal(res.body.arrivals[0].reservationId, 'onday');
  assert.equal(res.body.range, null, 'range is null when date was used');
});

test('?date= for a past day returns that day, not today', async () => {
  reset();
  const past = dayOffset(-3);
  reservations = [
    { id: 'past1', status: 'CONFIRMED', guestId: 'g9', guestName: 'Past Guest', confirmationNumber: 'CN-9',
      checkIn: `${past}T00:00:00.000Z`, checkOut: `${dayOffset(-1)}T00:00:00.000Z`, adults: 1, children: 0, roomTypeCode: 'STD' },
  ];
  const res = await call(makeApp(), 'GET', `/api/arrivals?date=${past}`, null);
  assert.equal(res.body.arrivals.length, 1);
  assert.equal(res.body.arrivals[0].overdue, false, 'nothing is overdue relative to its own day');
});

test('date wins over range when both are sent', async () => {
  reset();
  reservations = [
    { id: 'far', status: 'CONFIRMED', guestId: 'g10', guestName: 'Far', confirmationNumber: 'CN-10',
      checkIn: `${dayOffset(20)}T00:00:00.000Z`, checkOut: `${dayOffset(21)}T00:00:00.000Z`, adults: 1, children: 0, roomTypeCode: 'STD' },
  ];
  const res = await call(makeApp(), 'GET', `/api/arrivals?date=${TODAY}&range=month`, null);
  assert.deepEqual(res.body.arrivals, [], 'the date window, not the month window');
});

// ── Degraded mode ───────────────────────────────────────────────────────────

test('an unreachable reservation service degrades to local stays, not a 500', async () => {
  reset();
  reservationReachable = false;
  await mockPrisma.stay.create({
    data: { reservationId: 'r9', status: 'PRE_ARRIVAL', guestName: 'Local Only',
      expectedCheckIn: new Date(`${TODAY}T02:00:00.000Z`), expectedCheckOut: new Date(`${dayOffset(2)}T02:00:00.000Z`) },
  });
  const res = await call(makeApp(), 'GET', '/api/arrivals', null);
  assert.equal(res.status, 200, 'the desk needs a list, even a partial one');
  assert.equal(res.body.degraded, true, 'a short list must never silently claim to be complete');
  assert.equal(res.body.arrivals.length, 1);
  assert.equal(res.body.arrivals[0].guestName, 'Local Only');
});

test('a healthy response is not marked degraded', async () => {
  reset();
  const res = await call(makeApp(), 'GET', '/api/arrivals', null);
  assert.equal(res.body.degraded, false);
  assert.deepEqual(res.body.arrivals, []);
});

test('the reservation service is asked only for CONFIRMED reservations', async () => {
  reset();
  await call(makeApp(), 'GET', '/api/arrivals?range=week', null);
  assert.equal(lastReservationQuery.get('status'), 'CONFIRMED');
  assert.ok(lastReservationQuery.get('checkInTo'), 'an arrival window must be sent');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/stay" && node --test src/routes/arrivals.test.js
```

Expected: FAIL. Most failures will be `Cannot read properties of undefined (reading 'length')` because the route still returns a bare array rather than `{ arrivals }`. **The first test is the one that matters** — it must fail, proving it reproduces the reported bug.

- [ ] **Step 3: Implement the rebuilt route**

In `services/stay/src/routes/stay.routes.js`, add the import near the other `lib/` requires at the top of the file (alongside the existing `const { localDayBounds, parseLocalDay } = require('../lib/date');` on line 9):

```js
const { arrivalsWindow } = require('../lib/arrivalsWindow');
```

`utcDayStart` and `utcDayKey` are also needed by the `?date=` branch. Extend the existing date import on line 9 — do NOT add a second require for the same module:

```js
const { localDayBounds, parseLocalDay, utcDayStart, utcDayKey } = require('../lib/date');
```

Then replace the whole `/arrivals` route (currently lines 110-126) with:

```js
// GET /api/arrivals?range=today|week|month
//
// WHY THIS READS RESERVATIONS AND NOT Stay ROWS
// ---------------------------------------------
// This route used to query Stay rows with status PRE_ARRIVAL. Those rows exist
// only because subscribers/redis.subscriber.js received a reservation:confirmed
// message. A reservation confirmed while this service was down, or seeded
// directly, never got a Stay row and was PERMANENTLY invisible to the front
// desk — there is no reconciliation anywhere. Guests were missing off the
// arrivals sheet and nothing reported it.
//
// So the RESERVATION is now the source of truth for "who is expected", and the
// local Stay row is the source of truth for "have they arrived".
//
// The Stay join is load-bearing, not belt-and-braces: Reservation.status is
// flipped to CHECKED_IN by ANOTHER Redis subscriber
// (services/reservation/src/subscribers/redis.subscriber.js), so it is exactly
// as lossy as the projection this route stopped reading. POST /api/check-in
// writes the Stay row synchronously, which is why excluding on the stay's status
// is what actually keeps an in-house guest off the arrivals list.
router.get('/arrivals', requireRole(...ROLE_GROUPS.OPS_READ), async (req, res) => {
  try {
    // `?date=` is the NIGHT AUDIT's and the reports service's form: exactly one
    // business day, no overdue rows. Dropping it would make the audit's
    // movements_snapshot record a wrong arrival count for every day it closes.
    // It wins over `range` when both are sent.
    const dateParam = req.query.date;
    const window = dateParam
      ? (() => {
          const day = utcDayKey(utcDayStart(dateParam));
          const next = utcDayKey(new Date(utcDayStart(dateParam).getTime() + 86400000));
          // overdueBefore === checkInFrom means nothing can be overdue: the audit
          // asks a bounded historical question, and rows from other days would
          // inflate its count.
          return { range: null, checkInFrom: day, checkInTo: next, overdueBefore: day };
        })()
      : arrivalsWindow(req.query.range);

    // Two queries, not one: the in-range window, plus everything still expected
    // from BEFORE today. An overdue arrival is a problem the desk must see in
    // every view — today's strict window is exactly why a guest who was due
    // yesterday and never turned up used to vanish off the screen instead of
    // demanding action.
    const qs = (params) => new URLSearchParams({ status: 'CONFIRMED', ...params }).toString();

    let reservations = [];
    let degraded = false;
    try {
      const [inRange, overdue] = await Promise.all([
        reservationCall.call(
          `${RESERVATION_URL}/api/reservations?${qs({
            checkInFrom: window.checkInFrom,
            checkInTo: window.checkInTo,
          })}`
        ),
        // Skipped entirely for ?date= (range === null there): overdueBefore
        // equals checkInFrom on that branch, so an overdue query would just
        // re-fetch rows the audit must not see.
        //
        // Keyed on `range`, NOT on comparing the two dates: arrivalsWindow()
        // sets overdueBefore === checkInFrom for EVERY range, so a date
        // comparison is always false and would disable overdue arrivals
        // everywhere.
        window.range !== null
          ? reservationCall.call(
              `${RESERVATION_URL}/api/reservations?${qs({ checkInTo: window.overdueBefore })}`
            )
          : Promise.resolve([]),
      ]);
      // A reservation cannot be both in-range and overdue, but de-duplicate by
      // id anyway rather than trusting two independent queries to stay disjoint.
      const byId = new Map();
      for (const r of [...(overdue || []), ...(inRange || [])]) byId.set(r.id, r);
      reservations = [...byId.values()];
    } catch (err) {
      // Fall back to the local projection rather than failing the page. A desk
      // with a partial list can still work; a desk with an error cannot. But the
      // response says so — a short list that silently claims to be complete is
      // the exact failure this route was rewritten to remove.
      console.error('[Stay] Arrivals: reservation service unreachable, degrading:', err.message);
      degraded = true;
    }

    if (degraded) {
      const local = await prisma.stay.findMany({
        where: { status: 'PRE_ARRIVAL' },
        orderBy: { expectedCheckIn: 'asc' },
      });
      return res.json({
        range: window.range,
        degraded: true,
        arrivals: local.map((s) => ({
          id: s.id,
          stayId: s.id,
          reservationId: s.reservationId,
          guestId: s.guestId,
          guestName: s.guestName,
          confirmationNumber: null,
          expectedCheckIn: s.expectedCheckIn,
          expectedCheckOut: s.expectedCheckOut,
          nights: null,
          adults: null,
          children: null,
          roomTypeCode: null,
          status: 'PRE_ARRIVAL',
          overdue: false,
        })),
      });
    }

    // One query for every stay involved, rather than one per reservation.
    const stays = reservations.length
      ? await prisma.stay.findMany({
          where: { reservationId: { in: reservations.map((r) => r.id) } },
        })
      : [];
    const stayByReservation = new Map(stays.map((s) => [s.reservationId, s]));

    // Statuses that mean the guest is no longer expected at the door.
    const ARRIVED = new Set(['IN_HOUSE', 'DEPARTED', 'NO_SHOW']);
    const overdueBefore = new Date(`${window.overdueBefore}T00:00:00.000Z`);

    const arrivals = reservations
      .map((r) => {
        const stay = stayByReservation.get(r.id) || null;
        if (stay && ARRIVED.has(stay.status)) return null;
        const checkIn = r.checkIn ? new Date(r.checkIn) : null;
        return {
          // The React key. A reservation with no stay row has no stay id, so
          // fall back to a prefixed reservation id rather than emitting null.
          id: stay?.id || `res:${r.id}`,
          stayId: stay?.id || null,
          reservationId: r.id,
          guestId: r.guestId,
          guestName: r.guestName,
          confirmationNumber: r.confirmationNumber || null,
          expectedCheckIn: r.checkIn,
          expectedCheckOut: r.checkOut,
          nights: r.nights ?? null,
          adults: r.adults ?? null,
          children: r.children ?? null,
          roomTypeCode: r.roomTypeCode || null,
          status: stay?.status || 'PRE_ARRIVAL',
          overdue: Boolean(checkIn && checkIn < overdueBefore),
        };
      })
      .filter(Boolean)
      // Overdue first — those are the rows that need someone to do something.
      // Then by expected arrival, soonest first.
      .sort((a, b) => {
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        return new Date(a.expectedCheckIn || 0) - new Date(b.expectedCheckIn || 0);
      });

    res.json({ range: window.range, degraded: false, arrivals });
  } catch (err) {
    console.error('[Stay] Arrivals error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/stay" && node --test src/routes/arrivals.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Confirm no other consumer depends on the old array shape**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
grep -rn "api/arrivals" --exclude-dir=node_modules web/src services scripts docs 2>/dev/null | grep -v "\.test\.js"
```

Expected: hits only in `web/src/pages/Arrivals.jsx` (updated in Task 4), `services/gateway/nginx.conf` (a proxy line, shape-agnostic), and documentation. **If any other service parses this response as an array, stop and add a task to update it.**

- [ ] **Step 6: Run the whole stay suite**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/stay" && npm test
```

Expected: all PASS, including `authz.test.js`, which walks the router and fails if any route lacks a guard. The rewritten route keeps `requireRole(...ROLE_GROUPS.OPS_READ)`, so it stays covered automatically — there is no table to update.

- [ ] **Step 7: Commit**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
git add services/stay/src/routes/stay.routes.js services/stay/src/routes/arrivals.test.js
git commit -m "$(cat <<'EOF'
fix: build arrivals from reservations so a confirmed booking can never go missing

/api/arrivals read PRE_ARRIVAL Stay rows, which exist only if a
reservation:confirmed Redis message was received. A reservation confirmed
while this service was down was permanently invisible to the front desk, with
no reconciliation anywhere.

The reservation is now the source of truth for who is expected; the local Stay
row for whether they have arrived. That join is load-bearing -- Reservation
.status=CHECKED_IN is set by another Redis subscriber and is just as lossy,
while POST /api/check-in writes the Stay row synchronously.

Adds range=today|week|month, surfaces overdue arrivals in every range, and
degrades to local stays with degraded:true rather than 500ing when the
reservation service is unreachable.

EOF
)"
```

---

### Task 4: Arrivals page — range switcher, overdue, richer columns

**Files:**
- Modify: `web/src/pages/Arrivals.jsx`
- Modify: `web/src/styles.css` (append the segmented-control rules)

**Interfaces:**
- Consumes: `GET /api/arrivals?range=` → `{ range, degraded, arrivals: [...] }` from Task 3; the existing `POST /api/check-in`, which already creates a `Stay` when none exists (`stay.routes.js:168`) — **no backend change is needed to check in a guest with no stay row**.
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Add the range state and unwrap the new response shape**

In `web/src/pages/Arrivals.jsx`, add state beside the existing `useState` calls:

```jsx
  // Which arrival window the desk is looking at. Server-resolved, so the client
  // never does date arithmetic on UTC-midnight reservation values.
  const [range, setRange] = useState('today');
  const [degraded, setDegraded] = useState(false);
```

Then change `load` to send the range and unwrap `{ arrivals }`. The other three calls are unchanged:

```jsx
  async function load({ live = false } = {}) {
    if (!live) setLoading(true);
    try {
      const [a, h, d, r] = await Promise.all([
        api.get(`/api/arrivals?range=${encodeURIComponent(range)}`),
        api.get('/api/in-house'),
        api.get('/api/departures'),
        api.get('/api/rooms'),
      ]);
      // /api/arrivals returns { range, degraded, arrivals } — it used to return
      // a bare array. Tolerate both so a stale cached bundle cannot blank the
      // list during a rolling deploy.
      setArrivals(Array.isArray(a.data) ? a.data : a.data.arrivals || []);
      setDegraded(Array.isArray(a.data) ? false : Boolean(a.data.degraded));
      setInHouse(h.data);
      setDepartures(d.data);
      setRooms(r.data);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }
```

- [ ] **Step 2: Reload when the range changes**

Replace the existing `useEffect(() => { load(); }, []);` with one that depends on `range`:

```jsx
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);
```

The `useLiveRefresh(load, { channels: channels('reservations', 'stays') })` line below it stays exactly as it is.

- [ ] **Step 3: Replace the Expected arrivals panel header and table**

Replace the whole `<div className="panel">` block that starts with `<h3>Expected arrivals` (currently around line 143) with:

```jsx
      <div className="panel">
        <div className="panel-head">
          <h3>
            Expected arrivals {loading && <span className="spinner" style={{ marginLeft: 8 }} />}
          </h3>
          {/* The range switcher sits in the panel header, top right. */}
          <div className="seg" role="group" aria-label="Arrival window">
            {[
              ['today', 'Today'],
              ['week', 'Week'],
              ['month', 'Month'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`seg-btn${range === value ? ' is-active' : ''}`}
                aria-pressed={range === value}
                onClick={() => setRange(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* A partial list must say so. Silently showing fewer arrivals than
            exist is the exact failure this screen was rebuilt to remove. */}
        {degraded && (
          <p className="error" style={{ marginTop: 0 }}>
            Showing locally-known arrivals only — the reservation service is
            unreachable, so this list may be incomplete.
          </p>
        )}

        {arrivals.length === 0 && !loading ? (
          <EmptyState
            kind="inbox"
            title="No expected arrivals"
            hint={
              range === 'today'
                ? 'Confirmed reservations arriving today will appear here. Try Week or Month for later arrivals.'
                : `No confirmed reservations arriving in the next ${range === 'week' ? '7' : '30'} days.`
            }
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th className="t-c"></th>
                <th>Confirmation</th>
                <th>Guest</th>
                <th>Expected in</th>
                <th className="t-c">Nights</th>
                <th className="t-c">Pax</th>
                <th className="t-c">Actions</th>
              </tr>
            </thead>
            <tbody>
              {arrivals.map((s) => (
                <tr key={s.id}>
                  <td className="t-c" style={{ width: 40 }}>
                    <Avatar name={s.guestName || 'Guest'} size={30} />
                  </td>
                  <td>
                    {s.confirmationNumber || s.reservationId?.slice(0, 8) || '—'}
                    {s.overdue && (
                      <>
                        {' '}
                        <span className="badge cancelled" title="Due before today and not yet arrived">
                          Overdue
                        </span>
                      </>
                    )}
                  </td>
                  <td>{s.guestName || <span className="muted">—</span>}</td>
                  <td>
                    {s.expectedCheckIn
                      ? new Date(s.expectedCheckIn).toLocaleDateString([], {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })
                      : '—'}
                  </td>
                  <td className="t-c">{s.nights ?? '—'}</td>
                  <td className="t-c">
                    {s.adults == null ? '—' : s.adults + (s.children || 0)}
                  </td>
                  <td className="t-actions">
                    <button
                      className="small"
                      onClick={() => setCheckInModal({ open: true, stay: s, roomId: '' })}
                    >
                      Check-in
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
```

Note the date is rendered with `toLocaleDateString`, not `toLocaleString`. `expectedCheckIn` is now a reservation's UTC-midnight `checkIn`, which carries no meaningful time-of-day — printing "12:00 AM" beside every guest would be noise dressed as information.

- [ ] **Step 4: Guard a future-dated check-in**

`submitCheckIn` currently posts immediately. Because Week and Month now show guests who are not due today, add a confirmation for a future arrival. Replace `submitCheckIn` with:

```jsx
  async function submitCheckIn(e) {
    e.preventDefault();
    const { stay, roomId } = checkInModal;
    if (!roomId) {
      toast.error('Select a room.');
      return;
    }
    // Week and Month show guests who are not due today. Early check-in is a real
    // and common thing to do, so this asks rather than refuses — but it names
    // the date, so it is a deliberate act rather than a misclick on the wrong row.
    const due = stay.expectedCheckIn ? new Date(stay.expectedCheckIn) : null;
    const todayKey = new Date().toISOString().slice(0, 10);
    if (due && due.toISOString().slice(0, 10) > todayKey) {
      const ok = await confirm({
        title: 'Early check-in',
        message: `${stay.guestName || 'This guest'} is not due until ${due.toLocaleDateString([], {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })}.`,
        detail: 'Checking them in now starts the stay today.',
        confirmLabel: 'Check in anyway',
      });
      if (!ok) return;
    }
    try {
      // reservationId/guestId/guestName are all a reservation carries, and
      // POST /api/check-in creates the Stay row when none exists — which is why
      // a guest with no stay row can be checked in from here with no backend
      // change at all.
      await api.post('/api/check-in', {
        reservationId: stay.reservationId,
        guestId: stay.guestId,
        guestName: stay.guestName,
        assignedRoomId: roomId,
      });
      toast.success(`${stay.guestName} checked in.`);
      setCheckInModal({ open: false, stay: null, roomId: '' });
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
```

- [ ] **Step 5: Add the segmented-control styles**

Append to `web/src/styles.css`:

```css
/* Segmented range switcher — used in the Arrivals panel header. Sized to sit
   level with an <h3> in .panel-head without stretching it. */
.seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface);
}
.seg-btn {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  padding: 5px 14px;
  cursor: pointer;
  border-right: 1px solid var(--border);
}
.seg-btn:last-child {
  border-right: 0;
}
.seg-btn:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.seg-btn.is-active {
  background: var(--primary);
  color: #fff;
}
.seg-btn.is-active:hover {
  background: var(--primary-hover);
}
```

Before writing these, confirm the custom property names actually exist:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
grep -n -- "--border:\|--surface:\|--surface-hover:\|--text-muted:\|--text:\|--primary:\|--primary-hover:" web/src/styles.css | head
```

If a name differs, use the one the file actually defines. Do not invent tokens — a missing custom property renders as transparent, which is how a control ends up invisible rather than obviously broken.

- [ ] **Step 6: Build the frontend**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/web" && npm run build
```

Expected: build succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
git add web/src/pages/Arrivals.jsx web/src/styles.css
git commit -m "$(cat <<'EOF'
feat: Today/Week/Month arrival ranges with check-in from any of them

Adds the range switcher to the Expected arrivals panel header, surfaces
overdue arrivals with a pill, and shows the real confirmation number,
nights and pax now that arrivals come from the reservation.

Check-in needs no backend change: POST /api/check-in already creates the
Stay row when none exists. A future-dated check-in asks first and names the
date, since Week and Month show guests who are not due today.

A degraded response renders a warning rather than a silently short list.

EOF
)"
```

---

### Task 5: Update the three other `/api/arrivals` consumers

**Files:**
- Modify: `web/src/pages/Dashboard.jsx:51`
- Modify: `services/audit/src/routes/audit.routes.js:257`
- Modify: `services/reports/src/routes/reports.routes.js:132`

**Interfaces:**
- Consumes: `GET /api/arrivals` → `{ range, degraded, arrivals: [...] }` from Task 3.
- Produces: nothing.

Task 3 changed the response from a bare array to an envelope. Three callers besides the Arrivals page read it, and every one of them treats the result as an array. Left unchanged, the night audit records `undefined` arrivals for every business day it closes — a silent corruption of financial records, which is why this task is not optional.

All three are the same one-line change, so this is **one dispatch, reviewed as one diff**.

- [ ] **Step 1: Write the failing test for the audit's movements snapshot**

The audit is the consumer where breakage is silent and permanent, so it gets the test. Append to `services/audit/src/routes/audit.test.js` if that file exists; otherwise create `services/audit/src/lib/movements.test.js` with the helper extracted. First check which:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS" && ls services/audit/src/routes/*.test.js services/audit/src/lib/*.test.js 2>/dev/null
```

Extract the counting into a pure helper in `services/audit/src/lib/movements.js`:

```js
// Counts a movements response from the stay service.
//
// /api/arrivals returns { range, degraded, arrivals } and /api/departures still
// returns a bare array. Reading `.length` off the arrivals envelope yielded
// undefined, which the audit then recorded as the day's arrival count -- a wrong
// number written into a financial record with nothing reporting it.
function movementCount(payload) {
  if (Array.isArray(payload)) return payload.length;
  if (payload && Array.isArray(payload.arrivals)) return payload.arrivals.length;
  return 0;
}

module.exports = { movementCount };
```

And its test, `services/audit/src/lib/movements.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { movementCount } = require('./movements');

test('counts the arrivals envelope', () => {
  assert.equal(movementCount({ range: 'today', degraded: false, arrivals: [{}, {}, {}] }), 3);
});

test('still counts a bare array, which /api/departures returns', () => {
  assert.equal(movementCount([{}, {}]), 2);
});

test('an empty envelope counts zero', () => {
  assert.equal(movementCount({ range: 'today', degraded: false, arrivals: [] }), 0);
});

// The regression this file exists for: reading .length off an envelope gave
// undefined, and undefined was written into the audit record as the count.
test('never returns undefined for a malformed or failed payload', () => {
  for (const bad of [null, undefined, {}, 'nope', 0]) {
    assert.equal(movementCount(bad), 0, `${JSON.stringify(bad)} must count 0, never undefined`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/audit" && node --test src/lib/movements.test.js
```

Expected: FAIL — `Cannot find module './movements'`.

- [ ] **Step 3: Create the helper and use it in the audit**

Create the file from Step 1, then in `services/audit/src/routes/audit.routes.js` add the import beside the other `lib/` requires and change the movements step:

```js
      return { arrivals: movementCount(arrivals), departures: movementCount(departures) };
```

replacing `{ arrivals: arrivals.length, departures: departures.length }`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/audit" && node --test src/lib/movements.test.js && npm test
```

Expected: all PASS.

- [ ] **Step 5: Update the reports service**

In `services/reports/src/routes/reports.routes.js`, in `GET /api/reports/arrivals`, unwrap the envelope. Change:

```js
    const data = await callService(`${STAY_URL}/api/arrivals${date ? `?date=${date}` : ''}`);
    const summary = { date, count: data.length, rows: data };
```

to:

```js
    const payload = await callService(`${STAY_URL}/api/arrivals${date ? `?date=${date}` : ''}`);
    // /api/arrivals returns { range, degraded, arrivals }; departures still
    // returns a bare array. Tolerate both so this keeps working either way.
    const data = Array.isArray(payload) ? payload : payload?.arrivals || [];
    const summary = { date, count: data.length, rows: data };
```

Leave `GET /api/reports/departures` alone — `/api/departures` is unchanged.

- [ ] **Step 6: Update the Dashboard**

In `web/src/pages/Dashboard.jsx`, in the `setData({ ... })` call, change `arrivals: a.data,` to:

```jsx
        // /api/arrivals returns { range, degraded, arrivals }. Tolerate a bare
        // array too, so a stale cached bundle cannot blank the dashboard during
        // a rolling deploy.
        arrivals: Array.isArray(a.data) ? a.data : a.data?.arrivals || [],
```

- [ ] **Step 7: Verify every consumer is updated**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
grep -rn "api/arrivals" web/src services --exclude-dir=node_modules | grep -v "\.test\.js" | grep -v nginx.conf | grep -v schema.prisma
```

Expected: four hits — the route definition itself, `Arrivals.jsx`, `Dashboard.jsx`, `audit.routes.js`, `reports.routes.js`. Confirm none of the consumers still calls `.length` or `.map` directly on the response.

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/audit" && npm test
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/reports" && npm test
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/web" && npm run build
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
git add services/audit/src/lib/movements.js services/audit/src/lib/movements.test.js \
        services/audit/src/routes/audit.routes.js \
        services/reports/src/routes/reports.routes.js web/src/pages/Dashboard.jsx
git commit -m "$(cat <<'EOF'
fix: unwrap the arrivals envelope in the audit, reports and dashboard

/api/arrivals now returns { range, degraded, arrivals }. All three of these
read .length or iterated the response directly, so the night audit would have
recorded undefined as the arrival count for every business day it closed --
a wrong number in a financial record with nothing reporting it.

EOF
)"
```

---

## Manual verification

Bring the stack up (`bash scripts/gen-env.sh` if `.env` is absent, then `docker compose up -d --build`; note `--build` needs network access).

1. **The core bug.** Create and confirm a reservation for today. Then stop the stay service (`docker compose stop stay-service`), create and confirm a *second* reservation for today, and start it again (`docker compose start stay-service`). The second reservation missed its `reservation:confirmed` event and has no `Stay` row. **Both** guests must appear under Expected arrivals. On `main`, only the first does.
2. **Ranges.** Book an arrival 3 days out and one 20 days out. Today shows neither; Week shows the first; Month shows both.
3. **Overdue.** Book and confirm a reservation with yesterday's check-in date. It appears in all three ranges with an Overdue pill, sorted above today's arrivals.
4. **Check-in from Week.** Switch to Week, check in the guest arriving in 3 days. Confirm the early-check-in dialog names the correct date. After confirming, they appear under In-House Guests and disappear from Expected arrivals.
5. **Check-in with no stay row.** Check in the guest from step 1 who has no `Stay` row. It must succeed and create the stay.
6. **Degraded mode.** `docker compose stop reservation-service`, reload Arrivals. The warning strip appears and the page still renders — no error toast, no blank screen.
