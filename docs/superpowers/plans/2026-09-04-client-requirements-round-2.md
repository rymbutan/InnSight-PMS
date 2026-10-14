# Client Requirements Round 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five requirement gaps from the Ms. Nichole Lago interview and add QR-based payment simulation and scannable guest documents, without giving up the system's offline capability.

**Architecture:** Every change lands in an existing service — no new services. Bill splitting and the FACILITY revenue category are additions to the folio service, which already has the schema for both (`Folio.stayId` is not unique; `TransactionType.TRANSFER` exists; `ChargeCode.category` is a free string). QR support is one new dependency (`qrcode`) plus one new environment variable (`PUBLIC_BASE_URL`) that decides what URL the codes encode, so the same build works on a laptop with the wifi off and on a public host.

**Tech Stack:** Node 22, Express, Prisma 6 + Postgres 16, Redis (live events), PDFKit (already in `stay` and `folio`), React 18 + Vite, nginx gateway, Docker Compose. Tests are `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-04-client-requirements-round-2.md` — the gap analysis, derived from `_Ms.-Nichole-Lago-transcript-interview.docx`.

---

## Global Constraints

Every task's requirements implicitly include this section. These are the rules this codebase enforces, and three of them have already caused shipped bugs.

- **A new API path prefix needs a gateway `location` block, or it 404s before reaching the service.** `/api/settings/*` was implemented, called by the frontend, and dead for days because `services/gateway/nginx.conf` had no location for it. Any new prefix in this plan must be added there.
- **`services/gateway/nginx.conf` is baked into the gateway image.** After editing it: `docker compose build gateway && docker compose up -d gateway`. Restarting is not enough.
- **Every new route needs a `requireRole(...)` guard.** Each service's `authz.test.js` walks the router's own layer stack and fails on any unguarded route. This is the default-deny enforcement — do not weaken it. Genuinely public endpoints are mounted in `src/index.js` *before* the auth middleware, following `app.get('/api/public/availability', ...)` in `services/inventory/src/index.js:39`.
- **Money is `BigInt` cents.** Never `Number` in arithmetic. ADR and RevPAR are stored in cents.
- **Seeds skip when data already exists.** `services/inventory/src/seed.js:39` and `services/folio/src/seed.js:19` both return early on `count() > 0`, so editing seed constants does nothing to an existing database. Any task changing seeded data must convert that seed to upserts (Task 1 and Task 2 do this) — `scripts/db-seed.sh` already documents seeds as idempotent, so this brings them in line with their own contract.
- **Shared library files are vendored, not imported.** `_shared/*.js` is copied into each service's `src/lib/`. After touching one, run `bash scripts/check-shared.sh` (also enforced in CI and pre-commit).
- **Prisma migrations:** author with `npx prisma migrate dev --name <name> --schema=src/prisma/schema.prisma` inside the service directory; containers run `migrate deploy` at start.
- **Reservation status spelling is `CANCELLED`; the staff role is `FRONT_DESK`.**
- **Offline is a hard requirement and stays one.** No task may introduce a runtime request to a host other than the one serving the app. The audit harness in Task 9 enforces this.
- **Test command**, run from inside a service directory: `npm test` (which is `node --test src/**/*.test.js`). The web app has no test runner; frontend changes are verified with the offline audit harness (Task 9) and by hand.

---

## Deployment context — read before Task 6

The client asked whether deploying to Vercel or Hostinger removes the "a phone cannot open localhost" problem. It does, with one hard constraint and one caveat, and Task 6 is designed around both.

**Vercel cannot host this system.** It runs static frontends and serverless functions. This stack is fifteen containers — Postgres, Redis, MinIO, Mailhog, an nginx gateway and nine long-lived Node/Prisma services. Vercel could host the `web` SPA alone, but that splits the browser's origin in two and breaks a load-bearing design decision: `web/src/api.js` sets `API_BASE = ''` so every request is same-origin, which is why there is no CORS, no preflight, and why the gateway's rate limiter sees the real client IP. Splitting origins means setting `VITE_API_URL`, adding the production origin to the CORS map at `nginx.conf:51`, widening the CSP `connect-src`, and handling preflight on every route. Possible, but it is undoing a deliberate architecture for no gain.

**Hostinger VPS is the right target** — it runs Docker, so `docker compose up -d` deploys the stack unchanged, the single-origin design survives intact, and a domain plus Let's Encrypt gives HTTPS. Note that Hostinger *shared* hosting cannot run Docker; this requires a VPS plan.

**HTTPS solves more than reachability.** A phone can open the URL, and the browser camera API becomes available — which only works on HTTPS or localhost. If the system should ever *scan* a code rather than only display one, public HTTPS hosting is what makes that possible at all.

**The caveat: public hosting and offline capability pull in opposite directions**, and the client asked for both in the same fortnight. They are not exclusive — the same compose file runs in both places. Task 6 therefore makes the QR target a single environment variable rather than a hardcoded host, following the precedent already set by `PORTAL_URL` in `services/reservation/src/lib/notifier.js:12`. Laptop demo with the wifi off: codes encode `http://localhost:8080` and are confirmed on-screen. Deployed: codes encode the public HTTPS origin and phones scan them for real. One build, one variable.

---

## Task 1: Fourth floor

The client described a four-floor hotel plan; the database has three floors of fifteen rooms. `web/src/sim/hotelMap.js` already lays out however many floors it is handed, so this is data. The blocker is that the inventory seed bails on an existing database, and `RoomType.totalInventory` must move with the room count or availability will refuse bookings for rooms that exist — the failure looks exactly like a booking-engine bug, as the comment at `seed.js:52` warns.

**Files:**
- Modify: `services/inventory/src/seed.js`
- Create: `services/inventory/src/lib/inventoryPlan.js`
- Test: `services/inventory/src/lib/inventoryPlan.test.js`

**Interfaces:**
- Produces: `planInventory(floors, roomTypes) -> { rooms: [{ number, typeCode, floor }], totals: { [typeCode]: number } }`

- [ ] **Step 1: Write the failing test**

Create `services/inventory/src/lib/inventoryPlan.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { planInventory } = require('./inventoryPlan');

const TYPES = [
  { code: 'STD', perFloor: 8 },
  { code: 'DLX', perFloor: 4 },
  { code: 'STE', perFloor: 2 },
  { code: 'PRES', perFloor: 1 },
];

test('numbers rooms as floor*100 + index', () => {
  const { rooms } = planInventory(2, TYPES);
  assert.equal(rooms.length, 30);
  assert.equal(rooms[0].number, '101');
  assert.equal(rooms[14].number, '115');
  assert.equal(rooms[15].number, '201');
  assert.equal(rooms[15].floor, 2);
});

test('totalInventory tracks the floor count', () => {
  assert.deepEqual(planInventory(4, TYPES).totals, { STD: 32, DLX: 16, STE: 8, PRES: 4 });
  assert.equal(planInventory(4, TYPES).rooms.length, 60);
});

test('a fourth floor keeps floors 1-3 numbered exactly as before', () => {
  const three = planInventory(3, TYPES).rooms.map((r) => r.number);
  const four = planInventory(4, TYPES).rooms.map((r) => r.number);
  assert.deepEqual(four.slice(0, three.length), three);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd services/inventory && npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './inventoryPlan'`.

- [ ] **Step 3: Write the implementation**

Create `services/inventory/src/lib/inventoryPlan.js`:

```js
// Room numbering and inventory totals, as a pure function so the numbering rule
// can be tested without a database.
//
// A room's number is floor * 100 + its index on that floor — 101…115, 201…215.
// The housekeeping map derives a room's floor with Math.floor(number / 100), so a
// flat 101…160 run would put every room on floor 1.
function planInventory(floors, roomTypes) {
  const rooms = [];
  const totals = {};
  for (const rt of roomTypes) totals[rt.code] = rt.perFloor * floors;

  for (let floor = 1; floor <= floors; floor += 1) {
    let idx = 1;
    for (const rt of roomTypes) {
      for (let i = 0; i < rt.perFloor; i += 1, idx += 1) {
        rooms.push({ number: String(floor * 100 + idx), typeCode: rt.code, floor });
      }
    }
  }
  return { rooms, totals };
}

module.exports = { planInventory };
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd services/inventory && npm test 2>&1 | tail -20
```

Expected: PASS, 3 tests.

If the numbering test fails on ordering, read the existing `roomsFor()` in `seed.js:24` and match its type ordering exactly — floors 1–3 must keep the numbers they already have in the database, which the third test guards.

- [ ] **Step 5: Rewrite the seed to upsert, and add the fourth floor**

In `services/inventory/src/seed.js`: set `const FLOORS = 4;`, delete the `roomsFor` function, require `planInventory`, and replace the early-return-plus-create body of `seed()` with upserts:

```js
const { planInventory } = require('./lib/inventoryPlan');

async function seed() {
  console.log('[Inventory] Seeding rooms and room types...');

  // Upsert rather than skip-if-any-exist. The old guard meant editing FLOORS or a
  // rate did nothing to a database that had ever been seeded, and scripts/db-seed.sh
  // already promises callers that every seed is idempotent.
  const { rooms, totals } = planInventory(FLOORS, ROOM_TYPES);

  for (const rt of ROOM_TYPES) {
    const data = {
      name: rt.name,
      baseRate: rt.baseRate,
      maxOccupancy: rt.maxOccupancy,
      // Must equal the number of rooms that actually exist: availability is
      // totalInventory minus held nights, so a count below the real one refuses
      // bookings for rooms standing empty.
      totalInventory: totals[rt.code],
    };
    await prisma.roomType.upsert({ where: { code: rt.code }, update: data, create: { code: rt.code, ...data } });
  }

  for (const r of rooms) {
    await prisma.room.upsert({
      where: { id: r.number },
      // Never reset status/assignment on an existing room — a re-seed must not wipe
      // a room that housekeeping has in progress.
      update: { typeCode: r.typeCode, floor: r.floor },
      create: { id: r.number, number: r.number, typeCode: r.typeCode, floor: r.floor, status: 'CLEAN' },
    });
  }

  console.log(`[Inventory] Seeded ${rooms.length} rooms across ${FLOORS} floors.`);
}
```

- [ ] **Step 6: Apply it and verify against the live database**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
bash scripts/db-seed.sh inventory
docker exec innsightpms-postgres-1 psql -U innsight -d innsight_inventory -t \
  -c 'select floor, count(*) from "Room" group by floor order by floor;'
docker exec innsightpms-postgres-1 psql -U innsight -d innsight_inventory -t \
  -c 'select code, "totalInventory" from "RoomType" order by code;'
```

Expected: four rows, fifteen rooms each; totals 32/16/8/4. Then open http://localhost:8080/housekeeping and confirm the map draws FLOOR 4.

- [ ] **Step 7: Commit**

```bash
git add services/inventory/src/seed.js services/inventory/src/lib/inventoryPlan.js services/inventory/src/lib/inventoryPlan.test.js
git commit -m "feat(inventory): add a fourth floor and make the seed idempotent"
```

---

## Task 2: FACILITY revenue category in the night audit

The client asked for walk-in facility transactions to appear in the audit under their own category. Today `GET /api/folios/daily-totals` sorts charges into exactly two buckets by looking up which charge codes have `category: 'ROOM'`; everything else falls into `otherRevenueCents`. So a non-guest paying for the pool is indistinguishable from a guest's minibar.

`ChargeCode.category` is a plain `String`, so no migration is needed for the category itself — only for the new column on `BusinessDay`.

**Files:**
- Modify: `services/folio/src/lib/folioSummary.js` (and its vendored copies — see Global Constraints)
- Modify: `services/folio/src/seed.js`
- Modify: `services/folio/src/routes/folio.routes.js:406-458` (`daily-totals`)
- Modify: `services/audit/src/prisma/schema.prisma`, `services/audit/src/routes/audit.routes.js:264-280`
- Modify: `web/src/pages/Audit.jsx`
- Test: `services/folio/src/lib/folioSummary.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `classifyTransactions(transactions, { roomCodes, facilityCodes })` returning the existing fields plus `facilityChargeCents: BigInt`; `daily-totals` response gains `facilityRevenueCents: string`.

- [ ] **Step 1: Write the failing test**

Append to `services/folio/src/lib/folioSummary.test.js` (create it if absent, with the same `require` header as the other tests in that directory):

```js
test('facility charges are counted apart from other extras', () => {
  const txs = [
    { type: 'CHARGE', chargeCode: 'RM', amountCents: 500000n, taxAmountCents: 0n },
    { type: 'CHARGE', chargeCode: 'POOL', amountCents: 20000n, taxAmountCents: 0n },
    { type: 'CHARGE', chargeCode: 'MB', amountCents: 15000n, taxAmountCents: 0n },
  ];
  const s = classifyTransactions(txs, {
    roomCodes: new Set(['RM']),
    facilityCodes: new Set(['POOL']),
  });
  assert.equal(s.roomChargeCents, 500000n);
  assert.equal(s.facilityChargeCents, 20000n);
  assert.equal(s.extraChargeCents, 15000n, 'a facility charge must not also land in extras');
});

test('a Set passed positionally still means roomCodes', () => {
  // Back-compat: /folios/:id/print and /folios/:id/statement call this with a
  // bare Set. Those call sites must keep working while they are migrated.
  const s = classifyTransactions(
    [{ type: 'CHARGE', chargeCode: 'RM', amountCents: 1000n, taxAmountCents: 0n }],
    new Set(['RM'])
  );
  assert.equal(s.roomChargeCents, 1000n);
  assert.equal(s.facilityChargeCents, 0n);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd services/folio && npm test 2>&1 | tail -20
```

Expected: FAIL — `facilityChargeCents` is `undefined`.

- [ ] **Step 3: Widen the classifier, keeping the old signature working**

In `services/folio/src/lib/folioSummary.js`, replace the signature and the `CHARGE` branch:

```js
// `codes` accepts either a bare Set of room charge codes (the original signature,
// still used by the statement and print routes) or { roomCodes, facilityCodes }.
function classifyTransactions(transactions, codes) {
  const roomCodes = codes instanceof Set ? codes : codes?.roomCodes || new Set();
  const facilityCodes = codes instanceof Set ? new Set() : codes?.facilityCodes || new Set();

  let roomChargeCents = 0n;
  let facilityChargeCents = 0n;
  let extraChargeCents = 0n;
  // ...existing counters unchanged...

    if (tx.type === 'CHARGE') {
      if (roomCodes.has(tx.chargeCode)) roomChargeCents += amount;
      else if (facilityCodes.has(tx.chargeCode)) facilityChargeCents += amount;
      else extraChargeCents += amount;
      taxCents += tax;
    }
```

Add `facilityChargeCents` to the returned object.

- [ ] **Step 4: Run the test and watch it pass, then sync the vendored copies**

```bash
cd services/folio && npm test 2>&1 | tail -20
cd "/Users/arymsr.vendiola/Documents/InnSight PMS" && bash scripts/check-shared.sh
```

Expected: tests PASS. If `check-shared.sh` reports drift, copy the file to the services it names and re-run until clean.

- [ ] **Step 5: Seed the facility charge codes**

In `services/folio/src/seed.js`, add to `CHARGE_CODES`:

```js
  { code: 'POOL', name: 'Swimming Pool', category: 'FACILITY', glAccount: '4310', taxable: true },
  { code: 'HALL', name: 'Function Hall', category: 'FACILITY', glAccount: '4320', taxable: true },
  { code: 'GYM', name: 'Gym', category: 'FACILITY', glAccount: '4330', taxable: true },
```

Replace the skip-if-present guard with upserts, for the reason given in Task 1:

```js
async function seed() {
  console.log('[Folio] Seeding charge codes...');
  for (const cc of CHARGE_CODES) {
    await prisma.chargeCode.upsert({ where: { code: cc.code }, update: cc, create: cc });
  }
  console.log(`[Folio] Seeded ${CHARGE_CODES.length} charge codes.`);
}
```

- [ ] **Step 6: Split the bucket in `daily-totals`**

In `services/folio/src/routes/folio.routes.js`, inside the `daily-totals` handler, load facility codes alongside room codes and accumulate a third total:

```js
    const codeRows = await prisma.chargeCode.findMany({
      where: { category: { in: ['ROOM', 'FACILITY'] } },
      select: { code: true, category: true },
    });
    const roomCodes = new Set(codeRows.filter((c) => c.category === 'ROOM').map((c) => c.code));
    const facilityCodes = new Set(codeRows.filter((c) => c.category === 'FACILITY').map((c) => c.code));

    let facilityRevenueCents = 0n;
    // ...in the CHARGE branch:
        if (roomCodes.has(t.chargeCode)) roomRevenueCents += t.amountCents;
        else if (facilityCodes.has(t.chargeCode)) facilityRevenueCents += t.amountCents;
        else otherRevenueCents += t.amountCents;
```

Add `facilityRevenueCents: facilityRevenueCents.toString()` to the JSON response.

- [ ] **Step 7: Carry it through the audit**

In `services/audit/src/prisma/schema.prisma`, add to `model BusinessDay` beside `otherRevenueCents`:

```prisma
  facilityRevenueCents BigInt @default(0)
```

Then:

```bash
cd services/audit && npx prisma migrate dev --name add_facility_revenue --schema=src/prisma/schema.prisma
```

In `services/audit/src/routes/audit.routes.js`, add the default to the `daily-totals` fallback object (`facilityRevenueCents: '0'`), read it in step 7 alongside the others (`const facilityRevenueCents = BigInt(revenue.facilityRevenueCents || 0);`), and persist it on the `BusinessDay` update.

- [ ] **Step 8: Show it on the Night Audit page**

In `web/src/pages/Audit.jsx`, add a Facility revenue row wherever `otherRevenueCents` is displayed, formatted with the same `formatPeso` helper the page already imports from `../lib/money`.

- [ ] **Step 9: Verify end to end**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
bash scripts/db-seed.sh folio
docker compose build folio-service audit-service web && docker compose up -d folio-service audit-service web
```

Sell a pool booking from the Amenities page as a walk-in, then open http://localhost:8080/audit and confirm the amount appears under Facility revenue and *not* under Other.

- [ ] **Step 10: Commit**

```bash
git add services/folio services/audit web/src/pages/Audit.jsx
git commit -m "feat(audit): report walk-in facility revenue as its own category"
```

---

## Task 3: Bill splitting

The client asked for splitting where a guest has several services or several payers. Less is missing than it appears: `Folio.stayId` is not unique and `POST /api/folios` accepts a `stayId` without objecting to a second one, so **multiple folios per stay already work**. `TransactionType.TRANSFER` already exists in the schema. What is missing is the ability to *move a charge* between a stay's folios, a UI for it, and a check-out that will not release a room with an unsettled second folio. The comment at `folio.routes.js:1078` records transfer as a deliberate omission — this task reverses that decision, so update that comment too.

Transfers post a reversing pair rather than reassigning `folioId`, because a folio that silently loses a line it once had is not an auditable bill, and teaching correct front-office practice is the point of the system.

**Files:**
- Create: `services/folio/src/lib/transfer.js`, `services/folio/src/lib/transfer.test.js`
- Modify: `services/folio/src/routes/folio.routes.js` (new route; comment at :1078)
- Modify: `services/stay/src/routes/stay.routes.js` (check-out guard)
- Modify: `web/src/pages/Folios.jsx`, `web/src/pages/ReservationDetail.jsx`

**Interfaces:**
- Consumes: `classifyTransactions` from Task 2.
- Produces: `planTransfer(tx, { fromFolioId, toFolioId, folioNumbers }) -> [debitRow, creditRow]`; `POST /api/folios/:id/transfer` with body `{ transactionId, toFolioId }`.

- [ ] **Step 1: Write the failing test**

Create `services/folio/src/lib/transfer.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { planTransfer } = require('./transfer');

const TX = {
  id: 'tx1', folioId: 'A', type: 'CHARGE', chargeCode: 'MB',
  description: 'Minibar', amountCents: 15000n, taxAmountCents: 1800n, quantity: 1,
};

test('a transfer nets to zero across the two folios', () => {
  const [out, into] = planTransfer(TX, { fromFolioId: 'A', toFolioId: 'B', folioNumbers: { A: 'F-1', B: 'F-2' } });
  assert.equal(out.folioId, 'A');
  assert.equal(into.folioId, 'B');
  assert.equal(out.amountCents + into.amountCents, 0n);
  assert.equal(out.taxAmountCents + into.taxAmountCents, 0n);
});

test('both rows are TRANSFER and name the other folio', () => {
  const [out, into] = planTransfer(TX, { fromFolioId: 'A', toFolioId: 'B', folioNumbers: { A: 'F-1', B: 'F-2' } });
  assert.equal(out.type, 'TRANSFER');
  assert.equal(into.type, 'TRANSFER');
  assert.match(out.description, /F-2/, 'the source line must say where it went');
  assert.match(into.description, /F-1/, 'the destination line must say where it came from');
  assert.equal(out.reversalOf, 'tx1');
});

test('the charge code is preserved so revenue stays classified', () => {
  const [out, into] = planTransfer(TX, { fromFolioId: 'A', toFolioId: 'B', folioNumbers: { A: 'F-1', B: 'F-2' } });
  assert.equal(out.chargeCode, 'MB');
  assert.equal(into.chargeCode, 'MB');
});

test('transferring to the same folio is refused', () => {
  assert.throws(
    () => planTransfer(TX, { fromFolioId: 'A', toFolioId: 'A', folioNumbers: { A: 'F-1' } }),
    /same folio/i
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd services/folio && npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './transfer'`.

- [ ] **Step 3: Write the implementation**

Create `services/folio/src/lib/transfer.js`:

```js
// Moving a charge between two folios of the same stay.
//
// A transfer posts a REVERSING PAIR rather than reassigning the transaction's
// folioId: a printed folio that silently loses a line it once carried is not an
// auditable bill, and the guest may already hold a copy. Both rows name the other
// folio, which is what a real property management system prints.
//
// The charge code travels with the money so the night audit still classifies it
// (see classifyTransactions) — a minibar charge moved to the company folio is
// still F&B revenue.
function planTransfer(tx, { fromFolioId, toFolioId, folioNumbers }) {
  if (fromFolioId === toFolioId) throw new Error('Cannot transfer to the same folio.');

  const amount = BigInt(tx.amountCents);
  const tax = BigInt(tx.taxAmountCents || 0);
  const base = {
    type: 'TRANSFER',
    chargeCode: tx.chargeCode,
    quantity: tx.quantity || 1,
    reversalOf: tx.id,
  };

  return [
    {
      ...base,
      folioId: fromFolioId,
      description: `${tx.description} — transferred to folio ${folioNumbers[toFolioId]}`,
      amountCents: -amount,
      taxAmountCents: -tax,
    },
    {
      ...base,
      folioId: toFolioId,
      description: `${tx.description} — transferred from folio ${folioNumbers[fromFolioId]}`,
      amountCents: amount,
      taxAmountCents: tax,
    },
  ];
}

module.exports = { planTransfer };
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd services/folio && npm test 2>&1 | tail -20
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Add the route**

In `services/folio/src/routes/folio.routes.js`, beside the other `/folios/:id/*` routes:

```js
// POST /api/folios/:id/transfer — move one transaction to another folio on the
// same stay. Both folios must be OPEN and belong to the same stay; splitting a
// bill across unrelated guests is not a thing a front desk may do.
router.post('/folios/:id/transfer', requireRole(...CASHIER), async (req, res) => {
  try {
    const { transactionId, toFolioId } = req.body;
    if (!transactionId || !toFolioId) {
      return res.status(400).json({ error: 'transactionId and toFolioId are required.' });
    }

    const [from, to] = await Promise.all([
      prisma.folio.findUnique({ where: { id: req.params.id } }),
      prisma.folio.findUnique({ where: { id: toFolioId } }),
    ]);
    if (!from || !to) return res.status(404).json({ error: 'Folio not found.' });
    if (from.status !== 'OPEN' || to.status !== 'OPEN') {
      return res.status(409).json({ error: 'Both folios must be open to transfer a charge.' });
    }
    if (!from.stayId || from.stayId !== to.stayId) {
      return res.status(409).json({ error: 'Folios must belong to the same stay.' });
    }

    const tx = await prisma.folioTransaction.findUnique({ where: { id: transactionId } });
    if (!tx || tx.folioId !== from.id) return res.status(404).json({ error: 'Transaction not found on this folio.' });
    if (tx.type === 'TRANSFER') return res.status(409).json({ error: 'A transfer cannot itself be transferred.' });

    const rows = planTransfer(tx, {
      fromFolioId: from.id,
      toFolioId: to.id,
      folioNumbers: { [from.id]: from.folioNumber, [to.id]: to.folioNumber },
    });

    const created = await prisma.$transaction(
      rows.map((data) => prisma.folioTransaction.create({ data: { ...data, postedBy: req.user?.sub } }))
    );

    redis.publish('folio:transferred', JSON.stringify({ fromFolioId: from.id, toFolioId: to.id, transactionId }));
    res.status(201).json({ transactions: created });
  } catch (err) {
    console.error('[Folio] Transfer error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});
```

Require `planTransfer` at the top of the file, and update the stale comment at `folio.routes.js:1078` — folio-to-folio transfer is now supported, so the printed folio should carry a "Transferred From/To Folio" line.

- [ ] **Step 6: Verify default-deny still holds**

```bash
cd services/folio && npm test 2>&1 | tail -20
```

Expected: PASS, including `authz.test.js`. A failure here means the new route has no guard.

- [ ] **Step 7: Refuse check-out while any folio is unsettled**

Find the check-out handler in `services/stay/src/routes/stay.routes.js` and, before the room is released, fetch every folio for the stay and block on a non-zero balance:

```js
    // Every folio on the stay must be settled, not just the first one. With bill
    // splitting a guest can leave a second folio open, and releasing the room
    // would strand the balance with no one to bill.
    const folios = await fetchJsonOrNull(`${FOLIO_URL}/api/folios?stayId=${encodeURIComponent(stay.id)}`);
    const unsettled = (folios || []).filter((f) => f.status === 'OPEN' && BigInt(f.balanceCents || 0) !== 0n);
    if (unsettled.length) {
      return res.status(409).json({
        error: `Cannot check out: ${unsettled.length} folio(s) still carry a balance.`,
        folios: unsettled.map((f) => f.folioNumber),
      });
    }
```

Confirm the shape `GET /api/folios?stayId=` actually returns before relying on `balanceCents`; if it does not include a balance, compute it with `classifyTransactions` as `/folios/:id/statement` does.

- [ ] **Step 8: Add the front-desk UI**

In `web/src/pages/Folios.jsx`: show every folio for the stay rather than one, add an "Add folio" button calling `POST /api/folios` with the stay's `stayId`, and give each transaction row a "Move to…" control that calls the new transfer endpoint and reloads. Follow the existing action-button and toast patterns on that page.

- [ ] **Step 9: Verify by hand**

Check a guest in, post a minibar charge and a laundry charge, open a second folio, move the minibar charge to it, and confirm: both folios show the transfer line, the totals net out, and check-out is refused until both are settled.

- [ ] **Step 10: Commit**

```bash
git add services/folio services/stay web/src/pages/Folios.jsx
git commit -m "feat(folio): split a bill across folios with auditable transfers"
```

---

## Task 4: Payment receipt

**Correction to the gap analysis:** the system already produces a folio bill as a PDF — `GET /api/folios/:id/print` at `folio.routes.js:1013` renders a full A4 statement with guest details, tariff and particulars. What does not exist is a **payment receipt**: proof that a specific amount was received, which is the document a guest asks for after paying a deposit. That is what this task adds, reusing the print route's layout helpers.

**Files:**
- Create: `services/folio/src/lib/receipt.js`, `services/folio/src/lib/receipt.test.js`
- Modify: `services/folio/src/routes/folio.routes.js`
- Modify: `web/src/pages/Folios.jsx`

**Interfaces:**
- Produces: `receiptModel(payment, folio, guestName) -> { receiptNumber, paidCents, method, paidAt, guestName, folioNumber }`; `GET /api/folios/:id/payments/:paymentId/receipt` returning `application/pdf`.

- [ ] **Step 1: Write the failing test**

Create `services/folio/src/lib/receipt.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { receiptModel } = require('./receipt');

const PAYMENT = { id: 'p1', amountCents: 250000n, method: 'CASH', createdAt: new Date('2026-09-04T02:30:00Z') };
const FOLIO = { id: 'f1', folioNumber: 'F-000123', currency: 'PHP' };

test('the receipt number is derived from the folio and payment', () => {
  const m = receiptModel(PAYMENT, FOLIO, 'Santos, Grace');
  assert.equal(m.receiptNumber, 'OR-F-000123-p1');
  assert.equal(m.folioNumber, 'F-000123');
});

test('the amount stays in cents and is never a float', () => {
  const m = receiptModel(PAYMENT, FOLIO, 'Santos, Grace');
  assert.equal(m.paidCents, 250000n);
  assert.equal(typeof m.paidCents, 'bigint');
});

test('a voided payment cannot be receipted', () => {
  assert.throws(() => receiptModel({ ...PAYMENT, status: 'VOIDED' }, FOLIO, 'X'), /voided/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd services/folio && npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './receipt'`.

- [ ] **Step 3: Write the implementation**

Create `services/folio/src/lib/receipt.js`:

```js
// The data behind a payment receipt, separated from its rendering so the numbers
// can be tested without producing a PDF.
//
// This is NOT the folio bill (see /folios/:id/print) — a receipt is proof that one
// specific payment was received, which is what a guest asks for after paying a
// deposit at reservation time.
function receiptModel(payment, folio, guestName) {
  if (payment.status === 'VOIDED') throw new Error('A voided payment has no receipt.');
  return {
    receiptNumber: `OR-${folio.folioNumber}-${payment.id}`,
    folioNumber: folio.folioNumber,
    currency: folio.currency || 'PHP',
    paidCents: BigInt(payment.amountCents),
    method: payment.method,
    paidAt: payment.createdAt,
    guestName: guestName || '—',
  };
}

module.exports = { receiptModel };
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd services/folio && npm test 2>&1 | tail -20
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Add the PDF route**

In `services/folio/src/routes/folio.routes.js`, add `GET /folios/:id/payments/:paymentId/receipt` guarded with `requireRole(...ROLE_GROUPS.DESK_AUDIT)`. Load the folio and payment, build the model, and render with PDFKit copying the header, `row()` helper and money formatting from the `print` route so the two documents look like they came from the same hotel. Set `Content-Type: application/pdf` and `Content-Disposition: inline; filename="receipt-<receiptNumber>.pdf"`.

- [ ] **Step 6: Add the front-desk button**

In `web/src/pages/Folios.jsx`, give each payment row a "Receipt" action that calls the new URL through the existing `downloadAuthed` helper — the same one `ReservationDetail.jsx:156` uses for the registration card.

- [ ] **Step 7: Verify and commit**

```bash
cd services/folio && npm test 2>&1 | tail -5
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
docker compose build folio-service web && docker compose up -d folio-service web
```

Take a payment, click Receipt, confirm the PDF opens and the amount matches. Then:

```bash
git add services/folio web/src/pages/Folios.jsx
git commit -m "feat(folio): issue a printable payment receipt"
```

---

## Task 5: Email a document to the guest

The client asked for the registration form or receipt to be sent to the guest by email. `services/reservation/src/lib/notifier.js` writes an SMTP conversation by hand and sends `Content-Type: text/plain` with no MIME multipart, so **it cannot carry an attachment**. It also points at Mailhog, which captures mail and never delivers it — correct for a classroom, and worth stating plainly to the client rather than implying real mail goes out.

**Files:**
- Modify: `services/reservation/src/lib/notifier.js` (and vendored copies)
- Create: `services/reservation/src/lib/notifier.test.js`
- Modify: `services/folio/src/routes/folio.routes.js`

**Interfaces:**
- Produces: `send({ to, subject, body, attachment })` where `attachment` is `{ filename, contentType, content: Buffer }`; `POST /api/folios/:id/payments/:paymentId/receipt/email`.

- [ ] **Step 1: Write the failing test**

Create `services/reservation/src/lib/notifier.test.js`, testing the message builder rather than the socket:

```js
const test = require('node:test');
const assert = require('node:assert');
const { buildMessage } = require('./notifier');

test('a message with no attachment stays plain text', () => {
  const msg = buildMessage({ to: 'g@x.test', from: 'h@x.test', subject: 'Hi', body: 'Hello' });
  assert.match(msg, /Content-Type: text\/plain/);
  assert.doesNotMatch(msg, /multipart/);
});

test('an attachment produces a multipart body with base64 content', () => {
  const msg = buildMessage({
    to: 'g@x.test', from: 'h@x.test', subject: 'Receipt', body: 'Attached.',
    attachment: { filename: 'r.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4') },
  });
  assert.match(msg, /Content-Type: multipart\/mixed; boundary="/);
  assert.match(msg, /Content-Disposition: attachment; filename="r\.pdf"/);
  assert.match(msg, /Content-Transfer-Encoding: base64/);
  assert.match(msg, new RegExp(Buffer.from('%PDF-1.4').toString('base64')));
});

test('a line consisting of a single dot is escaped', () => {
  // A bare "." ends an SMTP DATA block. Unescaped, a PDF or a message body
  // containing one truncates the mail silently.
  const msg = buildMessage({ to: 'a@x.test', from: 'b@x.test', subject: 'S', body: 'one\r\n.\r\ntwo' });
  assert.match(msg, /\r\n\.\.\r\n/);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd services/reservation && npm test 2>&1 | tail -20
```

Expected: FAIL — `buildMessage` is not exported.

- [ ] **Step 3: Extract and extend the message builder**

In `notifier.js`, pull the header/body string construction out of `send()` into an exported `buildMessage({ to, from, subject, body, attachment })`. With no attachment it produces exactly what it produces today. With one, emit a `multipart/mixed` body: a boundary, a `text/plain` part, then the attachment part as base64 wrapped at 76 columns. Apply SMTP dot-stuffing (`\r\n.` becomes `\r\n..`) across the whole message, and have `send()` write `buildMessage(...)` followed by the terminating `\r\n.\r\n`.

- [ ] **Step 4: Run the test and watch it pass, then sync vendored copies**

```bash
cd services/reservation && npm test 2>&1 | tail -20
cd "/Users/arymsr.vendiola/Documents/InnSight PMS" && bash scripts/check-shared.sh
```

- [ ] **Step 5: Add the send-receipt endpoint**

In the folio service, add `POST /folios/:id/payments/:paymentId/receipt/email` guarded with `requireRole(...ROLE_GROUPS.DESK)`. Render the same PDF as Task 4 into a Buffer, look up the guest's email through the guest service, and send it. Return `202` with the address it went to. If the guest has no email on file, return `400` with a message saying so — the front desk needs to know why nothing happened.

- [ ] **Step 6: Verify against Mailhog**

```bash
docker compose build folio-service reservation-service && docker compose up -d folio-service reservation-service
```

Send a receipt, then open http://localhost:8025, confirm the mail is listed with a PDF attachment, and download it from Mailhog to check it opens.

- [ ] **Step 7: Commit**

```bash
git add services/reservation/src/lib/notifier.js services/reservation/src/lib/notifier.test.js services/folio services/*/src/lib/notifier.js
git commit -m "feat(notifier): support MIME attachments and email a receipt"
```

---

## Task 6: One configurable public base URL

Groundwork for both QR tasks, and the piece that keeps the system working in both the offline lab and a public deployment. `PORTAL_URL` in `notifier.js:12` already sets the precedent; this generalises it to a single variable read by everything that emits a link.

**Files:**
- Create: `_shared/publicUrl.js` and its vendored copies in `services/folio/src/lib/`, `services/stay/src/lib/`, `services/reservation/src/lib/`
- Create: `services/folio/src/lib/publicUrl.test.js`
- Modify: `docker-compose.yml`, `scripts/gen-env.sh`, `services/reservation/src/lib/notifier.js`

**Interfaces:**
- Produces: `publicUrl(path) -> string` — absolute URL built on `PUBLIC_BASE_URL`.

- [ ] **Step 1: Write the failing test**

Create `services/folio/src/lib/publicUrl.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { makePublicUrl } = require('./publicUrl');

test('joins without doubling or dropping slashes', () => {
  assert.equal(makePublicUrl('http://localhost:8080')('/portal/R-1'), 'http://localhost:8080/portal/R-1');
  assert.equal(makePublicUrl('http://localhost:8080/')('/portal/R-1'), 'http://localhost:8080/portal/R-1');
  assert.equal(makePublicUrl('https://innsight.example')('portal/R-1'), 'https://innsight.example/portal/R-1');
});

test('a QR pointing at localhost is flagged as unscannable', () => {
  // A phone cannot open localhost — it resolves to the phone. Callers that print a
  // code need to know whether to show a scan prompt or an on-screen fallback.
  assert.equal(makePublicUrl('http://localhost:8080').isScannableByPhone, false);
  assert.equal(makePublicUrl('https://innsight.example').isScannableByPhone, true);
  assert.equal(makePublicUrl('http://192.168.1.20:8080').isScannableByPhone, true);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd services/folio && npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './publicUrl'`.

- [ ] **Step 3: Write the implementation**

Create `_shared/publicUrl.js`:

```js
// The one place that decides what a guest-facing link says.
//
// The system runs in two modes and must keep working in both: on a laptop with the
// wifi off, where the only reachable address is localhost, and on a public host,
// where a phone can open the link and scan a code. A single environment variable
// separates them — no build-time branching, no second image.
//
// `isScannableByPhone` is false for localhost because a phone resolving "localhost"
// reaches itself. Callers use it to choose between a scan prompt and an on-screen
// confirmation, so an offline demo degrades honestly instead of printing a dead code.
function makePublicUrl(base) {
  const root = String(base || 'http://localhost:8080').replace(/\/+$/, '');
  const fn = (path) => `${root}/${String(path).replace(/^\/+/, '')}`;
  fn.base = root;
  fn.isScannableByPhone = !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(root);
  return fn;
}

const publicUrl = makePublicUrl(process.env.PUBLIC_BASE_URL || process.env.PORTAL_URL);

module.exports = { makePublicUrl, publicUrl };
```

- [ ] **Step 4: Vendor it, run the test, check for drift**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
for s in folio stay reservation; do cp _shared/publicUrl.js services/$s/src/lib/publicUrl.js; done
cd services/folio && npm test 2>&1 | tail -10
cd "/Users/arymsr.vendiola/Documents/InnSight PMS" && bash scripts/check-shared.sh
```

Expected: tests PASS, `check-shared.sh` clean.

- [ ] **Step 5: Wire the variable through compose and env generation**

In `docker-compose.yml`, add to the `environment:` block of `folio-service`, `stay-service` and `reservation-service`:

```yaml
      # What guest-facing links and QR codes point at. localhost is correct for an
      # offline laptop demo; set this to the public origin when deployed, and the
      # same image starts printing scannable codes with no rebuild.
      PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-http://localhost:8080}
```

In `scripts/gen-env.sh`, write `PUBLIC_BASE_URL=http://localhost:8080` into a fresh `.env` with a comment pointing at the deployment note.

Then point `notifier.js` at `publicUrl('/portal/' + r.confirmationNumber)` instead of its own `PORTAL_URL` concatenation, so there is one answer rather than two.

- [ ] **Step 6: Commit**

```bash
git add _shared/publicUrl.js services/*/src/lib/publicUrl.js services/folio/src/lib/publicUrl.test.js docker-compose.yml scripts/gen-env.sh services/reservation/src/lib/notifier.js
git commit -m "feat: single PUBLIC_BASE_URL for every guest-facing link"
```

---

## Task 7: QR codes on guest documents

The client asked whether receipts, folios and guest information could carry a scannable QR giving a digital copy. The guest portal at `/portal/:confirmationNumber` already exists, so the destination is built — this adds the code, and the token that makes it safe to print.

A printed receipt is a physical object anyone can pick up, so the QR encodes a short-lived signed token rather than a raw confirmation number.

**Files:**
- Modify: `services/folio/package.json`, `services/stay/package.json` (add `qrcode`)
- Create: `services/stay/src/lib/qr.js`, `services/stay/src/lib/qr.test.js`
- Modify: `services/stay/src/routes/stay.routes.js:474+` (registration card), `services/folio/src/routes/folio.routes.js` (receipt, folio print)

**Interfaces:**
- Consumes: `publicUrl` from Task 6.
- Produces: `qrPngBuffer(text) -> Promise<Buffer>` for PDFKit embedding.

- [ ] **Step 1: Add the dependency**

```bash
cd services/stay && npm install qrcode@1.5.4 && cd ../folio && npm install qrcode@1.5.4
```

`qrcode` is pure JavaScript with no native build step and makes no network request, which is what keeps this offline-safe.

- [ ] **Step 2: Write the failing test**

Create `services/stay/src/lib/qr.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { qrPngBuffer } = require('./qr');

test('produces a real PNG buffer', async () => {
  const buf = await qrPngBuffer('https://innsight.example/portal/R-1');
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic bytes');
});

test('refuses an empty payload rather than printing an unreadable square', async () => {
  await assert.rejects(() => qrPngBuffer(''), /empty/i);
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd services/stay && npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './qr'`.

- [ ] **Step 4: Write the implementation**

Create `services/stay/src/lib/qr.js` (and copy to `services/folio/src/lib/qr.js`):

```js
const QRCode = require('qrcode');

// A QR code as a PNG buffer, for embedding in a PDF with doc.image().
//
// Rendered locally with no network call, so printed documents keep working with
// the wifi off. Error-correction level M survives a photocopied or slightly
// smudged receipt, which is the realistic failure mode for a printed code.
async function qrPngBuffer(text) {
  if (!text) throw new Error('Refusing to render an empty QR code.');
  return QRCode.toBuffer(String(text), {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 220,
  });
}

module.exports = { qrPngBuffer };
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
cd services/stay && npm test 2>&1 | tail -20
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Put the code on the registration card**

In the `registration-card` route at `stay.routes.js:474`, after the detail rows:

```js
    const link = publicUrl(`/portal/${encodeURIComponent(reservation?.confirmationNumber || stay.id)}`);
    doc.image(await qrPngBuffer(link), 400, 120, { width: 110 });
    doc.fontSize(8).fillColor('#555').text('Scan for your digital copy', 400, 236, { width: 110, align: 'center' });
    doc.fillColor('black');
```

Do the same on the receipt from Task 4 and the folio print route. Where `publicUrl.isScannableByPhone` is false, still print the code — it is valid, just only openable from the host machine — and let Task 8 handle the interactive case.

- [ ] **Step 7: Verify and commit**

Download a registration card, scan the code with a phone (with `PUBLIC_BASE_URL` set to the machine's LAN address and both devices on the same wifi), and confirm it opens the guest portal.

```bash
git add services/stay services/folio
git commit -m "feat: print a guest-portal QR on registration cards and receipts"
```

---

## Task 8: QR payment simulation

The client asked whether payment could be simulated with a generated QR code. Nothing here touches real payment rails, so a simulated e-wallet is exactly as valid as the simulated card payments the system already takes. The teaching value is in the live update: the folio service publishes to Redis and the front-desk screen refreshes the moment the payment lands.

The intent is a database row rather than a signed token, because a teaching system should be able to *show* students the pending intent, and because it gives single-use enforcement for free.

**Files:**
- Modify: `services/folio/src/prisma/schema.prisma`
- Create: `services/folio/src/lib/paymentIntent.js`, `services/folio/src/lib/paymentIntent.test.js`
- Modify: `services/folio/src/routes/folio.routes.js`, `services/folio/src/index.js` (public confirm route)
- Modify: `services/gateway/nginx.conf`
- Create: `web/src/pages/SimulatedPayment.jsx`
- Modify: `web/src/App.jsx`, `web/src/pages/Folios.jsx`

**Interfaces:**
- Consumes: `publicUrl` (Task 6), `qrPngBuffer` (Task 7).
- Produces: `POST /api/folios/:id/payment-intents` → `{ token, url, expiresAt, qrDataUrl }`; public `POST /api/public/payment-intents/:token/confirm`; SPA route `/pay/:token`.

- [ ] **Step 1: Add the model**

In `services/folio/src/prisma/schema.prisma`:

```prisma
model PaymentIntent {
  id          String              @id @default(uuid())
  token       String              @unique
  folioId     String
  amountCents BigInt
  method      String              @default("QR_WALLET")
  status      PaymentIntentStatus @default(PENDING)
  expiresAt   DateTime
  confirmedAt DateTime?
  createdAt   DateTime            @default(now())
  createdBy   String?

  @@index([folioId, status])
}

enum PaymentIntentStatus {
  PENDING
  CONFIRMED
  EXPIRED
  CANCELLED
}
```

```bash
cd services/folio && npx prisma migrate dev --name add_payment_intent --schema=src/prisma/schema.prisma
```

- [ ] **Step 2: Write the failing test**

Create `services/folio/src/lib/paymentIntent.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { newToken, intentState } = require('./paymentIntent');

test('tokens are unguessable and url-safe', () => {
  const a = newToken(), b = newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32, 'a short token can be brute-forced against an open endpoint');
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test('a pending intent past its expiry reads as expired', () => {
  const past = new Date(Date.now() - 1000);
  assert.equal(intentState({ status: 'PENDING', expiresAt: past }, new Date()), 'EXPIRED');
});

test('a confirmed intent stays confirmed and cannot be replayed', () => {
  const past = new Date(Date.now() - 1000);
  assert.equal(intentState({ status: 'CONFIRMED', expiresAt: past }, new Date()), 'CONFIRMED');
});

test('a live pending intent is payable', () => {
  const future = new Date(Date.now() + 60000);
  assert.equal(intentState({ status: 'PENDING', expiresAt: future }, new Date()), 'PENDING');
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd services/folio && npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './paymentIntent'`.

- [ ] **Step 4: Write the implementation**

Create `services/folio/src/lib/paymentIntent.js`:

```js
const crypto = require('node:crypto');

// A pending simulated payment.
//
// The confirm endpoint is unauthenticated — it is opened by whatever scans the
// code — so the token is the only thing standing between a stranger and a posted
// payment. 32 bytes of CSPRNG output, single use, and short-lived.
function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Expiry is derived, never stored as a status: a row written PENDING would
// otherwise stay payable forever unless something swept it.
function intentState(intent, now = new Date()) {
  if (intent.status !== 'PENDING') return intent.status;
  return new Date(intent.expiresAt) <= now ? 'EXPIRED' : 'PENDING';
}

module.exports = { newToken, intentState, INTENT_TTL_MS: 15 * 60 * 1000 };
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
cd services/folio && npm test 2>&1 | tail -20
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Add the staff-side create route**

In `folio.routes.js`, guarded with `requireRole(...CASHIER)`:

```js
// POST /api/folios/:id/payment-intents — generate a QR for a simulated payment.
router.post('/folios/:id/payment-intents', requireRole(...CASHIER), async (req, res) => {
  try {
    const amountCents = BigInt(req.body.amountCents || 0);
    if (amountCents <= 0n) return res.status(400).json({ error: 'A payment amount is required.' });

    const folio = await prisma.folio.findUnique({ where: { id: req.params.id } });
    if (!folio) return res.status(404).json({ error: 'Folio not found.' });
    if (folio.status !== 'OPEN') return res.status(409).json({ error: 'This folio is not open.' });

    const intent = await prisma.paymentIntent.create({
      data: {
        token: newToken(),
        folioId: folio.id,
        amountCents,
        expiresAt: new Date(Date.now() + INTENT_TTL_MS),
        createdBy: req.user?.sub,
      },
    });

    const url = publicUrl(`/pay/${intent.token}`);
    res.status(201).json({
      token: intent.token,
      url,
      expiresAt: intent.expiresAt,
      qrDataUrl: await qrDataUrl(url),
      // The front desk needs to know whether to say "scan this" or "confirm on screen".
      scannable: publicUrl.isScannableByPhone,
    });
  } catch (err) {
    console.error('[Folio] Payment intent error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});
```

Add a `qrDataUrl` helper beside `qrPngBuffer` using `QRCode.toDataURL` — the browser needs a data URI, which the gateway CSP already permits via `img-src 'self' data:`.

- [ ] **Step 7: Add the public confirm route**

In `services/folio/src/index.js`, **before** the auth middleware, following the pattern at `services/inventory/src/index.js:39`:

```js
// PUBLIC — opened by whatever scanned the code, so no token from our own auth.
// The intent token is the credential; it is single-use and expires.
app.get('/api/public/payment-intents/:token', async (req, res) => { /* returns amount + state, no guest data */ });

app.post('/api/public/payment-intents/:token/confirm', async (req, res) => {
  // 1. find by token; 404 if absent
  // 2. intentState(...) must be PENDING, else 409 with the state
  // 3. in one prisma.$transaction: mark CONFIRMED, create the Payment row, and
  //    post a PAYMENT FolioTransaction — the same three writes /folios/:id/payments makes
  // 4. redis.publish('payment:received', JSON.stringify({ folioId, amountCents: String(...) }))
  // 5. respond { status: 'CONFIRMED', folioNumber }
});
```

Marking the intent CONFIRMED inside the same transaction as the payment is what makes a double scan safe.

- [ ] **Step 8: Route it at the gateway**

In `services/gateway/nginx.conf`, beside the other `/api/public/` locations:

```nginx
        location ~ ^/api/public/payment-intents { proxy_pass http://$up_folio; }
```

Without this the endpoint 404s before reaching the service — the `/api/settings` failure mode from the Global Constraints.

- [ ] **Step 9: Build the payer page**

Create `web/src/pages/SimulatedPayment.jsx` — a public page like `PublicBooking.jsx`, needing no login. It reads the token from the route, fetches the intent, and shows the amount, the hotel name, a prominent **Confirm payment** button, and a clear "Simulated payment — no money moves" banner so no student mistakes it for a real wallet. On confirm it POSTs and shows a success state. Handle `EXPIRED` and `CONFIRMED` with plain explanations rather than a generic error.

Register it in `web/src/App.jsx` beside the other public routes:

```jsx
      <Route path="/pay/:token" element={<SimulatedPayment />} />
```

- [ ] **Step 10: Add the front-desk side**

In `web/src/pages/Folios.jsx`, add a "Charge by QR" action that posts the intent, then shows the returned `qrDataUrl` in a panel with the amount and a countdown to `expiresAt`. When `scannable` is false, label it "Open this code on this machine to confirm" and include the link — an offline demo then degrades honestly instead of showing a code nobody can scan. Subscribe the page to the `payment:received` channel through `useLiveRefresh` so the folio refreshes the instant the payment posts.

- [ ] **Step 11: Verify the whole loop**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
docker compose build folio-service gateway web && docker compose up -d folio-service gateway web
cd services/folio && npm test 2>&1 | tail -5
```

Open a folio, click Charge by QR, open the URL in a second browser window, confirm, and watch the folio update without a manual refresh. Then confirm a second time and check it is refused as already used.

- [ ] **Step 12: Commit**

```bash
git add services/folio services/gateway/nginx.conf web/src/pages/SimulatedPayment.jsx web/src/App.jsx web/src/pages/Folios.jsx
git commit -m "feat(folio): simulate wallet payment via a scannable QR intent"
```

---

## Task 9: Re-run the offline audit

Every task above adds a code path that could reach the network. This task proves none of them do, and is the gate before any deployment work.

**Files:**
- Modify: `scripts/` — promote the session's audit harness to `scripts/offline-audit.mjs`

- [ ] **Step 1: Promote the harness**

Copy the harness used in this session's audit to `scripts/offline-audit.mjs`. It launches headless Chrome with `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost`, logs in, walks every route, and reports any external request, failed load, uncaught exception or HTTP status ≥ 400.

- [ ] **Step 2: Add the new routes to its sweep**

Add `/pay/<a real token>` to the route list, and extend the 3D pass to exercise Charge by QR and the receipt download.

- [ ] **Step 3: Run it**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
AUDIT_PASS='<admin password>' node scripts/offline-audit.mjs
```

Expected: every route clean; **zero** external requests. A non-zero count means something in Tasks 1–8 reaches the internet and must be fixed before deploying, because the client also demonstrates this system with the wifi off.

- [ ] **Step 4: Commit**

```bash
git add scripts/offline-audit.mjs
git commit -m "test: keep the offline audit as a repeatable script"
```

---

## Task 10: Deployment preparation (Hostinger VPS)

Do this only once Tasks 1–9 are green. It changes no application behaviour — it makes the same stack safe to expose.

- [ ] **Step 1: Point the base URL at the real origin**

In the server's `.env`: `PUBLIC_BASE_URL=https://<the domain>`. Nothing else changes; QR codes immediately become phone-scannable because `isScannableByPhone` turns true.

- [ ] **Step 2: Add the production origin to the gateway**

In `services/gateway/nginx.conf:51`, replace the placeholder comment in the CORS map with the real hostname. Even though the design is single-origin, the map is what would allow a future split.

- [ ] **Step 3: Terminate TLS**

Put the Let's Encrypt certificate in front of the gateway — either a `certbot` container renewing into a mounted volume with `listen 443 ssl` added to the gateway server block, or Hostinger's own reverse proxy forwarding to port 8080. Add an HTTP→HTTPS redirect. Confirm the CSP still allows everything the 3D needs: `'wasm-unsafe-eval'` in `script-src` and `blob:` in `connect-src`, or every model silently fails to load.

- [ ] **Step 4: Rotate every secret**

```bash
bash scripts/gen-env.sh   # into a fresh .env on the server, never the committed one
```

Change the admin password from the one in `HOW-TO-OPEN-EDITOR.md` before the host is publicly reachable. That file documents a live credential and must not travel to a public deployment.

- [ ] **Step 5: Do not publish the infrastructure ports**

In a production compose override, remove the host port mappings for `postgres` (5433), `redis` (6380), `minio` (9000/9001) and `mailhog` (1025/8025). Only the gateway should be reachable. Verify from another machine:

```bash
nmap -p 5433,6380,8025,9000 <the host>
```

Expected: closed/filtered on all four.

- [ ] **Step 6: Confirm the offline path still works**

On the laptop, with `PUBLIC_BASE_URL` back at `http://localhost:8080`, run `docker compose up -d` with the wifi off and re-run Task 9's audit. Deployment must not have cost the classroom demo.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.prod.yml services/gateway/nginx.conf
git commit -m "chore: production deployment configuration"
```

---

## Deferred — needs a decision from the client

**Excel export.** Reports currently download `text/csv`, which Excel opens without complaint. Producing a true `.xlsx` — with column widths, number formats and a header row that survives — needs a spreadsheet library in the frontend bundle. Ask Ms. Nichole whether "exported to Excel" means the file opens in Excel (already true, no work) or that it must be an `.xlsx` file (roughly a day). Do not build it on a guess.

---

## Self-Review

**Spec coverage.** All five gaps are covered: fourth floor (Task 1), facility revenue category (Task 2), bill splitting (Task 3), receipt output and email (Tasks 4–5), Excel export (deferred with an explicit reason). Both QR requests are covered: documents (Task 7) and payment simulation (Task 8). The deployment question is answered before Task 6 and executed in Task 10. Offline capability is protected by Task 9 and re-checked in Task 10 Step 6.

**Two corrections against the published gap analysis**, found while gathering evidence for this plan, and reflected in the tasks above:
1. The system *does* already produce a folio bill PDF (`/folios/:id/print`). The missing document is a payment receipt, which is what Task 4 builds.
2. Multiple folios per stay are *already* creatable — `Folio.stayId` is not unique and `POST /api/folios` accepts a second one. Task 3 is therefore transfer, check-out validation and UI, not a schema change.

**Type consistency.** `classifyTransactions` gains an options object in Task 2 and is consumed with that shape in Tasks 3 and 4; the positional `Set` form is kept and tested so existing call sites do not break. `publicUrl` is defined in Task 6 and consumed in Tasks 7 and 8. `qrPngBuffer` is defined in Task 7 and consumed in Task 8 alongside `qrDataUrl`, which Task 8 Step 6 adds explicitly. `planTransfer`, `receiptModel`, `newToken` and `intentState` are each defined and consumed within their own task.

**Sequencing.** Task 6 precedes Tasks 7 and 8 because both consume `publicUrl`. Task 2 precedes Task 3 because the transfer route classifies transactions. Task 4 precedes Task 5 because the email attaches the receipt PDF. Task 9 precedes Task 10.
