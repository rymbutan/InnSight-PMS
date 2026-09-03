# Walk-Ins & Non-Guest Sales Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement section 2 of the panel's change list — visitor/non-hotel-guest terminology, per-piece laundry ticketing, a divisible function hall with real booking-conflict enforcement, richer amenity pricing detail, and a night-audit view that shows all daily sales rather than room revenue alone.

**Architecture:** Five largely independent items. Three are UI/seed-data only. The two substantive pieces are a new folio endpoint that posts a multi-line laundry ticket as one authoritative-priced charge, and a parent/child facility relation whose booking-conflict rule is enforced both in the route and by a Postgres exclusion constraint over a per-leaf slot-lock table.

**Tech Stack:** Node.js/Express/Prisma/PostgreSQL microservices (`services/inventory`, `services/folio`), React/Vite frontend (`web/`), Node's built-in `node:test` runner, `btree_gist` (already installed in the inventory database).

**Spec:** `docs/superpowers/specs/2026-08-18-walkins-amenities-design.md`

## Global Constraints

- Money is always integer cents. Frontend formats via `formatPeso`/`pesosToCents`/`centsToPesos` from `web/src/lib/money.js`.
- **Never trust a client-supplied price.** Every charge amount is recomputed server-side from the authoritative `Facility` record, exactly as `POST /api/folios/amenity-sale` already does.
- Every new Express route MUST carry `requireRole(...)`. Each service's `routes/authz.test.js` walks the router and fails if any route lacks a guard.
- **Migrations must be idempotent** — `scripts/db-init.sh` re-applies every non-baseline migration file via `prisma db execute` on *every* container start. Use `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`, `ON CONFLICT DO NOTHING`.
- Cross-service reads use `AbortSignal.timeout(SERVICE_TIMEOUT_MS)` and a service token; a pricing lookup that fails must fail the sale (502), never post an unverified amount.
- Time ranges use half-open `'[)'` semantics — a booking ending at 14:00 does not overlap one starting at 14:00.
- Placeholder prices introduced here are seed data, editable from the admin UI. Only polo ₱200 / long-sleeve ₱150 come from the source document.

---

### Task 1: Night audit — show all daily sales

**Files:**
- Modify: `web/src/pages/Audit.jsx` (current-day metrics block ~lines 80-86; history table head ~lines 123-133 and body ~lines 136-149)

**Interfaces:**
- Consumes: `BusinessDay.otherRevenueCents` — already computed by `POST /api/audit/run` and already returned by the audit API. No backend change.

- [ ] **Step 1: Add current-day revenue metrics**

In `web/src/pages/Audit.jsx`, the current-day `<div className="metrics">` block currently holds only the in-house count. Replace that block with:

```jsx
            <div className="metrics" style={{ marginBottom: 12 }}>
              <div className="metric">
                <div className="label">In-house stays</div>
                <div className="value">{inHouseCount}</div>
              </div>
              <div className="metric">
                <div className="label">Room revenue</div>
                <div className="value">{formatPeso(current.roomRevenueCents ?? 0)}</div>
              </div>
              <div className="metric">
                <div className="label">Other revenue</div>
                <div className="value">{formatPeso(current.otherRevenueCents ?? 0)}</div>
              </div>
              <div className="metric">
                <div className="label">Total revenue</div>
                <div className="value">
                  {formatPeso(Number(current.roomRevenueCents ?? 0) + Number(current.otherRevenueCents ?? 0))}
                </div>
              </div>
            </div>
```

- [ ] **Step 2: Add the history columns**

In the history `<thead>`, replace `<th>Room revenue</th>` with:

```jsx
                <th>Room revenue</th>
                <th>Other revenue</th>
                <th>Total revenue</th>
```

In the `<tbody>` row, replace `<td>{formatPeso(d.roomRevenueCents)}</td>` with:

```jsx
                  <td>{formatPeso(d.roomRevenueCents)}</td>
                  <td>{formatPeso(d.otherRevenueCents ?? 0)}</td>
                  <td>{formatPeso(Number(d.roomRevenueCents ?? 0) + Number(d.otherRevenueCents ?? 0))}</td>
```

- [ ] **Step 3: Update the explanatory copy**

Replace the `<p className="muted">` describing the audit with one that reflects that amenity/visitor sales are included:

```jsx
            <p className="muted">
              The audit posts a room charge to each in-house folio, combines all of the day's sales —
              rooms plus amenities, laundry, spa and visitor sales — marks overdue reservations as
              no-show, and closes the day.
            </p>
```

- [ ] **Step 4: Verify the build**

Run: `cd web && npm run build`
Expected: build succeeds.

Then open the Night Audit page and confirm the current-day panel shows four metrics and the history table shows the three revenue columns.

---

### Task 2: Visitor / non-hotel-guest terminology

**Files:**
- Modify: `web/src/pages/Amenities.jsx` (walk-in POS panel, ~lines 202-208; guest-name field label ~line 227)
- Modify: `web/src/pages/Folios.jsx` (wherever folio `type` is rendered — locate with grep in Step 2)

**Interfaces:** none — copy only.

- [ ] **Step 1: Reword the POS panel**

In `web/src/pages/Amenities.jsx`, replace the panel heading and description:

```jsx
          <h3>Visitor sale (non-hotel guest)</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Charge a visitor — someone using an amenity without staying at the hotel. No room
            assignment is needed; the sale is tracked on its own visitor folio.
          </p>
```

Relabel the guest-name field from `Guest name (optional)` to:

```jsx
                  <label>Visitor name (optional)</label>
```

- [ ] **Step 2: Render the WALKIN folio type as "Visitor"**

Run: `grep -rn "WALKIN" web/src --include="*.jsx"`

For each hit that renders the raw type string to staff, display `Visitor` instead. If a shared mapping object exists, add `WALKIN: 'Visitor'` there; if the type is printed bare (e.g. `{f.type}`), wrap it:

```jsx
{f.type === 'WALKIN' ? 'Visitor' : f.type}
```

Do **not** change the `WALKIN` enum value itself, any comparison against it, or the value sent to the API — display text only.

- [ ] **Step 3: Verify the build**

Run: `cd web && npm run build`
Expected: build succeeds. Confirm in the browser that the amenities POS panel reads "Visitor sale (non-hotel guest)" and folio lists show "Visitor".

---

### Task 3: Laundry ticket — pure helper

**Files:**
- Create: `services/folio/src/lib/laundryTicket.js`
- Create: `services/folio/src/lib/laundryTicket.test.js`

**Interfaces:**
- Produces: `buildLaundryTicket(lines: Array<{name, priceCents, qty}>): { totalCents: number, description: string }`. Throws `Error` with a clear message when no valid line is present.
- Consumed by: Task 4 (the endpoint).

- [ ] **Step 1: Write the failing test**

Create `services/folio/src/lib/laundryTicket.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { buildLaundryTicket } = require('./laundryTicket');

test('single line: price times quantity', () => {
  const t = buildLaundryTicket([{ name: 'Polo', priceCents: 20000, qty: 2 }]);
  assert.equal(t.totalCents, 40000);
  assert.equal(t.description, 'Laundry: 2× Polo');
});

test('multiple lines sum and itemise in order', () => {
  const t = buildLaundryTicket([
    { name: 'Polo', priceCents: 20000, qty: 2 },
    { name: 'Long-sleeve shirt', priceCents: 15000, qty: 1 },
  ]);
  assert.equal(t.totalCents, 55000);
  assert.equal(t.description, 'Laundry: 2× Polo, 1× Long-sleeve shirt');
});

test('lines with zero or missing quantity are dropped', () => {
  const t = buildLaundryTicket([
    { name: 'Polo', priceCents: 20000, qty: 1 },
    { name: 'Dress', priceCents: 25000, qty: 0 },
  ]);
  assert.equal(t.totalCents, 20000);
  assert.equal(t.description, 'Laundry: 1× Polo');
});

test('a ticket with no usable line is rejected', () => {
  assert.throws(() => buildLaundryTicket([]), /at least one/i);
  assert.throws(() => buildLaundryTicket([{ name: 'Polo', priceCents: 20000, qty: 0 }]), /at least one/i);
});

test('a fractional or negative quantity is rejected', () => {
  assert.throws(() => buildLaundryTicket([{ name: 'Polo', priceCents: 20000, qty: 1.5 }]), /whole number/i);
  assert.throws(() => buildLaundryTicket([{ name: 'Polo', priceCents: 20000, qty: -2 }]), /whole number/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/folio && node --test src/lib/laundryTicket.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `services/folio/src/lib/laundryTicket.js`:

```js
// Builds a per-piece laundry ticket: several garment lines charged as ONE folio
// transaction (Changes-to-be-made doc, item 2 — laundry is priced per piece,
// e.g. ₱200 a polo, not per load).
//
// Pure on purpose: the money and the guest-visible wording are the parts that
// must not drift, and this way they are testable without a database or HTTP.
function buildLaundryTicket(lines) {
  if (!Array.isArray(lines)) throw new Error('A laundry ticket needs at least one garment line.');

  const usable = [];
  for (const line of lines) {
    const qty = Number(line?.qty ?? 0);
    // A fractional or negative count is a caller bug, not an empty line — say so
    // rather than silently dropping it and undercharging the guest.
    if (!Number.isInteger(qty) || qty < 0) {
      throw new Error('Each garment quantity must be a whole number of pieces, zero or more.');
    }
    if (qty === 0) continue;
    usable.push({ name: line.name, priceCents: Number(line.priceCents), qty });
  }

  if (usable.length === 0) throw new Error('A laundry ticket needs at least one garment line.');

  const totalCents = usable.reduce((sum, l) => sum + l.priceCents * l.qty, 0);
  const description = `Laundry: ${usable.map((l) => `${l.qty}× ${l.name}`).join(', ')}`;
  return { totalCents, description };
}

module.exports = { buildLaundryTicket };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/folio && node --test src/lib/laundryTicket.test.js`
Expected: PASS (5 tests).

---

### Task 4: Laundry sale endpoint

**Files:**
- Modify: `services/folio/src/routes/folio.routes.js` (import the helper near the other `../lib/` requires; add the route immediately after the `POST /folios/amenity-sale` handler)

**Interfaces:**
- Consumes: `buildLaundryTicket` (Task 3); `GET /api/facilities/:code` on the inventory service; the existing module-level `serviceToken()`, `INVENTORY_URL`, `SERVICE_TIMEOUT_MS`, and `nextFolioNumber()`.
- Produces: `POST /api/folios/laundry-sale`, body `{ items: [{facilityCode, qty}], guestName?, method?, stayId? }`, guarded by `CASHIER`. Returns `201 { folio, totalCents, description }`.

- [ ] **Step 1: Import the helper**

In `services/folio/src/routes/folio.routes.js`, alongside the existing `receiptWords` / `folioSummary` requires:

```js
const { buildLaundryTicket } = require('../lib/laundryTicket');
```

- [ ] **Step 2: Add the route**

Insert immediately after the `POST /folios/amenity-sale` handler's closing `});`:

```js
// POST /api/folios/laundry-sale — per-piece laundry ticket (Changes-to-be-made
// doc, item 2). Several garment lines are priced authoritatively from inventory
// and posted as ONE charge, so the guest sees a single itemised laundry line
// rather than a transaction per sock.
//
// With a stayId the charge lands on that stay's open folio and settles at
// checkout; without one it opens a visitor (WALKIN) folio, takes payment and
// closes it — the same shape as amenity-sale.
router.post('/folios/laundry-sale', requireRole(...CASHIER), async (req, res) => {
  try {
    const { items, guestName, method, stayId } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items must be a non-empty array of { facilityCode, qty }.' });
    }
    if (!stayId && !method) {
      return res.status(400).json({ error: 'method is required for a visitor laundry sale.' });
    }

    // Authoritative pricing — never trust a client-supplied amount. One lookup
    // per distinct garment code.
    const lines = [];
    for (const item of items) {
      if (!item?.facilityCode) return res.status(400).json({ error: 'Each item needs a facilityCode.' });
      let f;
      try {
        const r = await fetch(`${INVENTORY_URL}/api/facilities/${encodeURIComponent(item.facilityCode)}`, {
          signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${serviceToken()}` },
        });
        if (r.status === 404)
          return res.status(404).json({ error: `Laundry item ${item.facilityCode} not found.` });
        if (!r.ok) throw new Error(`facility lookup ${r.status}`);
        f = await r.json();
      } catch (e) {
        return res.status(502).json({ error: 'Could not verify laundry pricing. Try again.' });
      }
      if (!f.active) return res.status(409).json({ error: `${f.name} is not currently offered.` });
      lines.push({ name: f.name, priceCents: f.priceCents, qty: item.qty });
    }

    let ticket;
    try {
      ticket = buildLaundryTicket(lines);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (!Number.isInteger(ticket.totalCents) || ticket.totalCents <= 0) {
      return res.status(400).json({ error: 'Computed amount is invalid.' });
    }

    const totalPieces = lines.reduce((n, l) => n + Number(l.qty || 0), 0);

    // ── In-house guest: post to the open folio, settle at checkout ──
    if (stayId) {
      const folio = await prisma.folio.findFirst({ where: { stayId, status: 'OPEN' } });
      if (!folio) return res.status(404).json({ error: 'No open folio for that stay.' });
      await prisma.folioTransaction.create({
        data: {
          folioId: folio.id,
          type: 'CHARGE',
          chargeCode: 'LD',
          description: ticket.description,
          amountCents: BigInt(ticket.totalCents),
          quantity: totalPieces,
          postedBy: req.user?.username || req.user?.sub,
          sourceSystem: 'laundry-pos',
        },
      });
      return res.status(201).json({ folio, totalCents: ticket.totalCents, description: ticket.description });
    }

    // ── Visitor: open a WALKIN folio, charge, pay, close — atomically ──
    const out = await prisma.$transaction(async (px) => {
      const folio = await px.folio.create({
        data: { folioNumber: nextFolioNumber(), type: 'WALKIN', currency: 'PHP' },
      });
      await px.folioTransaction.create({
        data: {
          folioId: folio.id,
          type: 'CHARGE',
          chargeCode: 'LD',
          description: `${ticket.description}${guestName ? ` — ${guestName}` : ''}`,
          amountCents: BigInt(ticket.totalCents),
          quantity: totalPieces,
          postedBy: req.user?.username || req.user?.sub,
          sourceSystem: 'laundry-pos',
        },
      });
      const payment = await px.payment.create({
        data: { folioId: folio.id, method, amountCents: BigInt(ticket.totalCents), status: 'CAPTURED' },
      });
      await px.folioTransaction.create({
        data: {
          folioId: folio.id,
          type: 'PAYMENT',
          description: `Payment via ${method}`,
          amountCents: BigInt(ticket.totalCents),
          paymentMethod: method,
          reference: payment.id,
          postedBy: req.user?.username || req.user?.sub,
        },
      });
      return px.folio.update({
        where: { id: folio.id },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
    });

    res.status(201).json({ folio: out, totalCents: ticket.totalCents, description: ticket.description });
  } catch (err) {
    console.error('[Folio] Laundry sale error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});
```

- [ ] **Step 3: Confirm the route is syntactically valid and guarded**

Run: `node -c services/folio/src/routes/folio.routes.js`
Expected: no output (valid).

Run: `cd services/folio && node --test src/routes/authz.test.js`
Expected: PASS — the new route carries `requireRole(...CASHIER)`.

- [ ] **Step 4: Verify live once Task 5's SKUs are seeded**

Deferred to Task 5 Step 6, which seeds the garment SKUs this endpoint prices against.

---

### Task 5: Inventory — parent/child facilities, slot locks, and seed data

**Files:**
- Modify: `services/inventory/src/prisma/schema.prisma` (`Facility` model: add `parentCode`, self-relation, `slotLocks` back-relation on `FacilityBooking`; add `FacilitySlotLock` model)
- Create: `services/inventory/src/prisma/migrations/20260818000100_divisible_facilities/migration.sql`
- Create: `services/inventory/src/lib/conflictScope.js`
- Create: `services/inventory/src/lib/conflictScope.test.js`
- Modify: `services/inventory/src/routes/inventory.routes.js` (`FACILITY_CATEGORIES` ~line 591; `POST /facility-bookings` ~line 755; `PATCH /facility-bookings/:id` ~line 900)
- Modify: `services/inventory/src/seed.js` (`FACILITIES` array from line 72)

**Interfaces:**
- Produces: `leafFacilityIds(facility, children): string[]`; `Facility.parentCode`; `FacilitySlotLock` rows written with each booking.
- Consumed by: Task 6 (UI hierarchy display).

- [ ] **Step 1: Write the failing test for the conflict-scope helper**

Create `services/inventory/src/lib/conflictScope.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { leafFacilityIds } = require('./conflictScope');

test('a facility with no children occupies only itself', () => {
  assert.deepEqual(leafFacilityIds({ id: 'mtg' }, []), ['mtg']);
});

test('a parent occupies all of its children, not itself', () => {
  const leaves = leafFacilityIds({ id: 'hall' }, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.deepEqual(leaves.sort(), ['a', 'b', 'c']);
});

test('undefined children behave as no children', () => {
  assert.deepEqual(leafFacilityIds({ id: 'gym' }, undefined), ['gym']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/inventory && node --test src/lib/conflictScope.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

Create `services/inventory/src/lib/conflictScope.js`:

```js
// Which physical spaces a facility booking actually occupies.
//
// A large space can be divided (Changes-to-be-made doc, item 2: the grand
// function hall splits into meeting rooms). Booking the whole hall consumes
// every section; booking one section consumes only that section. Expressing a
// booking as the SET OF LEAVES it occupies makes the conflict rule a plain
// intersection test:
//
//   hall vs section A   → {a,b,c} ∩ {a} = {a}  → clash
//   section A vs A      → {a} ∩ {a}     = {a}  → clash
//   section A vs B      → {a} ∩ {b}     = {}   → no clash  ← siblings are independent
//
// It is also what lets a single Postgres exclusion constraint enforce the rule:
// see the FacilitySlotLock table in migrations/20260818000100_divisible_facilities.
function leafFacilityIds(facility, children) {
  const kids = Array.isArray(children) ? children : [];
  if (kids.length === 0) return [facility.id];
  return kids.map((c) => c.id);
}

module.exports = { leafFacilityIds };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/inventory && node --test src/lib/conflictScope.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Update the Prisma schema**

In `services/inventory/src/prisma/schema.prisma`, add to the `Facility` model (after `description`):

```prisma
  parentCode   String?
  parent       Facility?         @relation("FacilityDivision", fields: [parentCode], references: [code])
  children     Facility[]        @relation("FacilityDivision")
```

Add to the `FacilityBooking` model (after `createdAt`):

```prisma
  slotLocks  FacilitySlotLock[]
```

Add a new model at the end of the file:

```prisma
// One row per (booking, leaf space, time range). A booking of a divisible
// parent writes one lock per child; a booking of an undivided space writes a
// single lock for itself. A Postgres exclusion constraint over
// (facilityId, [startAt,endAt)) then makes overlapping claims on the same
// physical space impossible — including hall-vs-section — while leaving
// sibling sections free to be booked at the same time. See the migration.
model FacilitySlotLock {
  id         String          @id @default(uuid())
  bookingId  String
  facilityId String
  startAt    DateTime
  endAt      DateTime
  booking    FacilityBooking @relation(fields: [bookingId], references: [id], onDelete: Cascade)

  @@index([facilityId, startAt, endAt])
  @@index([bookingId])
}
```

- [ ] **Step 6: Write the migration**

Create `services/inventory/src/prisma/migrations/20260818000100_divisible_facilities/migration.sql`:

```sql
-- Divisible spaces (Changes-to-be-made doc, item 2): a grand function hall that
-- can be sold whole or split into smaller meeting rooms.
--
-- Every statement is idempotent: scripts/db-init.sh re-applies this file via
-- `prisma db execute` on EVERY container start, on top of whatever
-- `migrate deploy` / `db push` already did.

-- ── Parent/child relation between facilities ────────────────────────────────
ALTER TABLE "Facility" ADD COLUMN IF NOT EXISTS "parentCode" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Facility_parentCode_fkey'
  ) THEN
    ALTER TABLE "Facility"
      ADD CONSTRAINT "Facility_parentCode_fkey"
      FOREIGN KEY ("parentCode") REFERENCES "Facility"("code")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- A space cannot be its own subdivision.
ALTER TABLE "Facility" DROP CONSTRAINT IF EXISTS "Facility_not_own_parent";
ALTER TABLE "Facility"
  ADD CONSTRAINT "Facility_not_own_parent"
  CHECK ("parentCode" IS NULL OR "parentCode" <> "code");

-- ── Per-leaf slot locks ─────────────────────────────────────────────────────
-- One row per physical space a booking occupies. Booking the whole hall writes
-- one lock per section; booking a section writes one lock for that section.
CREATE TABLE IF NOT EXISTS "FacilitySlotLock" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacilitySlotLock_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FacilitySlotLock_facilityId_startAt_endAt_idx"
  ON "FacilitySlotLock"("facilityId", "startAt", "endAt");
CREATE INDEX IF NOT EXISTS "FacilitySlotLock_bookingId_idx"
  ON "FacilitySlotLock"("bookingId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FacilitySlotLock_bookingId_fkey'
  ) THEN
    ALTER TABLE "FacilitySlotLock"
      ADD CONSTRAINT "FacilitySlotLock_bookingId_fkey"
      FOREIGN KEY ("bookingId") REFERENCES "FacilityBooking"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- btree_gist supplies the `=` operator class needed to combine an equality
-- column with a range-overlap test in one exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE BACKSTOP. No two live bookings may claim the same physical space over
-- overlapping time.
--
-- '[)' is half-open: a function ending at 14:00 and another starting at 14:00
-- do NOT overlap, which is how back-to-back bookings actually work.
--
-- Because a booking is decomposed into one lock per LEAF space, this single
-- constraint expresses the whole rule:
--   • whole hall vs. section A → both hold a lock on A       → rejected
--   • section A  vs. section A → both hold a lock on A       → rejected
--   • section A  vs. section B → locks on A and B, disjoint  → allowed
-- A constraint on FacilityBooking.facilityId could not express that, because
-- siblings must not exclude one another.
--
-- The application also checks this (POST /api/facility-bookings) and returns a
-- friendly 409. This is the last line of defence against two clerks booking
-- simultaneously; if it ever fires, a write path skipped the lock flow.
--
-- If creation fails, overlapping locks already exist. Find them with:
--
--   SELECT a."bookingId", b."bookingId", a."facilityId", a."startAt", a."endAt"
--   FROM "FacilitySlotLock" a
--   JOIN "FacilitySlotLock" b
--     ON a."facilityId" = b."facilityId"
--    AND a.id < b.id
--    AND tsrange(a."startAt", a."endAt", '[)')
--     && tsrange(b."startAt", b."endAt", '[)');
--
-- ...then cancel one side of each pair before re-running.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "FacilitySlotLock" DROP CONSTRAINT IF EXISTS "FacilitySlotLock_no_double_booking";
ALTER TABLE "FacilitySlotLock"
  ADD CONSTRAINT "FacilitySlotLock_no_double_booking"
  EXCLUDE USING gist (
    "facilityId" WITH =,
    tsrange("startAt", "endAt", '[)') WITH &&
  );

-- A slot must last a positive amount of time.
ALTER TABLE "FacilitySlotLock" DROP CONSTRAINT IF EXISTS "FacilitySlotLock_end_after_start";
ALTER TABLE "FacilitySlotLock"
  ADD CONSTRAINT "FacilitySlotLock_end_after_start"
  CHECK ("endAt" > "startAt");

-- ── Seed the hall's sections + the new amenity SKUs ─────────────────────────
-- ON CONFLICT DO NOTHING so re-running never overwrites prices an admin has
-- since edited in the UI.
INSERT INTO "Facility" ("id","code","name","category","pricingModel","priceCents","unit","capacity","reservable","active","description","parentCode","createdAt","updatedAt")
VALUES
  (gen_random_uuid()::text,'HALL_A','Function Hall — Section A','EVENT_HALL','PER_HOUR',60000,'per hour',40,true,true,'One third of the Grand Function Hall, divided by air wall.','HALL',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'HALL_B','Function Hall — Section B','EVENT_HALL','PER_HOUR',60000,'per hour',40,true,true,'One third of the Grand Function Hall, divided by air wall.','HALL',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'HALL_C','Function Hall — Section C','EVENT_HALL','PER_HOUR',60000,'per hour',40,true,true,'One third of the Grand Function Hall, divided by air wall.','HALL',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'LDY_POLO','Laundry — Polo','LAUNDRY','PER_USE',20000,'per piece',NULL,false,true,'Wash, dry and press, per polo shirt.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'LDY_LONGSLEEVE','Laundry — Long-sleeve shirt','LAUNDRY','PER_USE',15000,'per piece',NULL,false,true,'Wash, dry and press, per long-sleeve shirt.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'LDY_TROUSERS','Laundry — Trousers','LAUNDRY','PER_USE',18000,'per piece',NULL,false,true,'Wash, dry and press, per pair of trousers.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'LDY_DRESS','Laundry — Dress','LAUNDRY','PER_USE',25000,'per piece',NULL,false,true,'Dry clean and press, per dress.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'LDY_BEDSHEET','Laundry — Bed sheet','LAUNDRY','PER_USE',22000,'per piece',NULL,false,true,'Wash and press, per bed sheet.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'VALET','Valet Parking','PARKING','PER_DAY',15000,'per day',NULL,false,true,'Attended valet parking, per calendar day.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'MASSAGE_60','Massage — 60 minutes','SPA','PER_USE',120000,'per session',NULL,false,true,'Sixty-minute full-body massage with a licensed therapist.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  (gen_random_uuid()::text,'MASSAGE_90','Massage — 90 minutes','SPA','PER_USE',170000,'per session',NULL,false,true,'Ninety-minute full-body massage with a licensed therapist.',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Retire the per-load laundry SKU in favour of the per-piece catalogue above.
-- Deactivated, NOT deleted: historical FolioTransaction rows carry
-- chargeCode 'LAUNDRY' and would lose their label.
UPDATE "Facility" SET "active" = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'LAUNDRY' AND "active" = true;

-- Narrow the old combined spa SKU to facility access now that massages are
-- their own services.
UPDATE "Facility"
SET "name" = 'Spa Access', "description" = 'Sauna, steam room and relaxation lounge. Massages are booked separately.'
WHERE "code" = 'SPA' AND "name" = 'Spa & Massage';
```

- [ ] **Step 7: Allow the new category and keep the seed file consistent**

In `services/inventory/src/routes/inventory.routes.js`, `FACILITY_CATEGORIES` already contains `PARKING` and `SPA`, so no change is needed for valet/massage. Confirm by reading the array; make no edit if all categories used above are present.

In `services/inventory/src/seed.js`, append the same eleven facilities to the `FACILITIES` array (it uses `upsert ... update: {}`, so re-running is already safe). Each entry follows the existing object shape, adding `parentCode: 'HALL'` for the three sections and omitting `parentCode` for the rest. This only matters for a from-scratch install; Step 6's migration is what reaches existing databases.

- [ ] **Step 8: Enforce the conflict rule in the booking route**

In `services/inventory/src/routes/inventory.routes.js`, import the helper near the top:

```js
const { leafFacilityIds } = require('../lib/conflictScope');
```

In `POST /facility-bookings`, replace the facility lookup and the single-facility clash check with a leaf-set check plus lock writes. Replace:

```js
    const f = await prisma.facility.findUnique({ where: { code: facilityCode } });
```

with:

```js
    const f = await prisma.facility.findUnique({
      where: { code: facilityCode },
      include: { children: true },
    });
```

Then replace the clash block:

```js
    // Exclusive-use clash check: no overlapping CONFIRMED booking for this facility.
    const clash = await prisma.facilityBooking.findFirst({
      where: { facilityId: f.id, status: 'CONFIRMED', startAt: { lt: end }, endAt: { gt: start } },
    });
    if (clash) return res.status(409).json({ error: 'That time slot is already booked for this facility.' });
```

with:

```js
    // A booking occupies a SET of physical spaces: the whole hall consumes every
    // section, a section consumes only itself. Two bookings clash when those sets
    // intersect — which is why sibling sections can be sold at the same time.
    const leaves = leafFacilityIds(f, f.children);
    const clash = await prisma.facilitySlotLock.findFirst({
      where: {
        facilityId: { in: leaves },
        startAt: { lt: end },
        endAt: { gt: start },
      },
    });
    if (clash) {
      const clashed = await prisma.facility.findUnique({ where: { id: clash.facilityId } });
      return res.status(409).json({
        error: `That time slot is already booked for ${clashed?.name || 'this space'}.`,
      });
    }
```

Then make the booking and its locks one transaction. Replace the `prisma.facilityBooking.create({...})` call with:

```js
    let booking;
    try {
      booking = await prisma.$transaction(async (px) => {
        const b = await px.facilityBooking.create({
          data: {
            facilityId: f.id,
            guestName,
            guestPhone,
            startAt: start,
            endAt: end,
            persons: persons || 1,
            priceCents,
            createdBy: req.user?.sub,
          },
          include: { facility: true },
        });
        await px.facilitySlotLock.createMany({
          data: leaves.map((facilityId) => ({
            bookingId: b.id,
            facilityId,
            startAt: start,
            endAt: end,
          })),
        });
        return b;
      });
    } catch (e) {
      // 23P01 = exclusion_violation: the database backstop caught a race the
      // check above could not, because a competing booking committed in between.
      if (e.code === 'P2010' || e.meta?.code === '23P01' || /23P01|exclusion/i.test(e.message)) {
        return res.status(409).json({ error: 'That time slot was just booked by someone else.' });
      }
      throw e;
    }
```

- [ ] **Step 9: Release locks when a booking is cancelled**

In `PATCH /facility-bookings/:id`, a cancellation must free the slot. Replace the update call:

```js
    const b = await prisma.facilityBooking.update({ where: { id: req.params.id }, data }).catch((e) => {
      if (e.code === 'P2025') return null;
      throw e;
    });
```

with:

```js
    const b = await prisma
      .$transaction(async (px) => {
        const updated = await px.facilityBooking.update({ where: { id: req.params.id }, data });
        // A cancelled booking must free its spaces immediately, or the hall stays
        // unbookable for a function that is no longer happening.
        if (data.status === 'CANCELLED') {
          await px.facilitySlotLock.deleteMany({ where: { bookingId: updated.id } });
        }
        return updated;
      })
      .catch((e) => {
        if (e.code === 'P2025') return null;
        throw e;
      });
```

- [ ] **Step 10: Apply schema, migration, and regenerate the client**

```bash
docker cp "services/inventory/src/prisma/schema.prisma" innsightpms-inventory-service-1:/app/src/prisma/schema.prisma
docker cp "services/inventory/src/prisma/migrations/20260818000100_divisible_facilities" innsightpms-inventory-service-1:/app/src/prisma/migrations/
docker exec innsightpms-inventory-service-1 sh -c "npx prisma migrate deploy --schema=src/prisma/schema.prisma"
docker exec innsightpms-inventory-service-1 sh -c "npx prisma generate --schema=src/prisma/schema.prisma"
```

Expected: migration applies; client regenerates with `facilitySlotLock` available.

Then prove idempotency — this is the step that catches a migration that would crash the container on its second boot:

```bash
docker exec innsightpms-inventory-service-1 sh -c "npx prisma db execute --file src/prisma/migrations/20260818000100_divisible_facilities/migration.sql --schema src/prisma/schema.prisma"
```

Expected: `Script executed successfully.`

- [ ] **Step 11: Run the tests**

Run: `cd services/inventory && node --test 'src/**/*.test.js'`
Expected: all pass, including `authz.test.js`.

- [ ] **Step 12: Verify the conflict matrix live**

Rebuild and restart the inventory service, then with a staff token exercise all four cases against `POST /api/facility-bookings`:

1. Book `HALL` 09:00–12:00 → 201.
2. Book `HALL_A` 10:00–11:00 (overlaps) → **409**.
3. Cancel the `HALL` booking, then book `HALL_A` 10:00–11:00 → 201.
4. Book `HALL_B` 10:00–11:00 (sibling, same time) → **201**.
5. Book `HALL_A` 10:30–11:30 (same section, overlapping) → **409**.
6. Book `HALL_A` 11:00–12:00 (back-to-back with case 3) → **201** (half-open ranges).
7. Book `HALL` 10:00–11:00 while a section is booked → **409**.

Then confirm the database backstop independently of the route by inserting an overlapping lock directly:

```bash
docker exec innsightpms-postgres-1 psql -U innsight -d innsight_inventory -c \
  "INSERT INTO \"FacilitySlotLock\" (id,\"bookingId\",\"facilityId\",\"startAt\",\"endAt\") \
   SELECT 'probe', \"bookingId\", \"facilityId\", \"startAt\", \"endAt\" FROM \"FacilitySlotLock\" LIMIT 1;"
```

Expected: rejected with `conflicting key value violates exclusion constraint`. Clean up any test bookings afterwards.

---

### Task 6: Amenities UI — laundry ticket panel and space hierarchy

**Files:**
- Modify: `web/src/pages/Amenities.jsx` (`CATEGORIES` ~line 9; facilities table body; add a laundry-ticket panel)

**Interfaces:**
- Consumes: `POST /api/folios/laundry-sale` (Task 4); `Facility.parentCode` (Task 5).

- [ ] **Step 1: Show sub-rooms under their parent**

In the facilities table body, indent a facility that has a `parentCode` so the hall's sections read as part of it. Where the row renders the facility name, replace the plain name cell with:

```jsx
                  <td style={{ paddingLeft: f.parentCode ? 28 : undefined }}>
                    {f.parentCode && <span className="muted">└ </span>}
                    {f.name}
                  </td>
```

Sort so children follow their parent: after loading `facilities`, order the list with each parent immediately followed by its children.

```js
  const orderedFacilities = useMemo(() => {
    const parents = facilities.filter((f) => !f.parentCode);
    const byParent = new Map();
    for (const f of facilities.filter((x) => x.parentCode)) {
      if (!byParent.has(f.parentCode)) byParent.set(f.parentCode, []);
      byParent.get(f.parentCode).push(f);
    }
    return parents.flatMap((p) => [p, ...(byParent.get(p.code) || [])]);
  }, [facilities]);
```

Render from `orderedFacilities` instead of `facilities` in the table.

- [ ] **Step 2: Add laundry-ticket state and handlers**

Inside the component, alongside the existing POS state:

```js
  // Laundry ticket — several garment lines charged as one folio line.
  const [laundryQty, setLaundryQty] = useState({}); // { [facilityCode]: qty }
  const [laundryGuest, setLaundryGuest] = useState('');
  const [laundryMethod, setLaundryMethod] = useState('CASH');

  const laundryItems = useMemo(
    () => facilities.filter((f) => f.category === 'LAUNDRY' && f.active),
    [facilities]
  );
  const laundryLines = useMemo(
    () =>
      laundryItems
        .map((f) => ({ f, qty: Number(laundryQty[f.code] || 0) }))
        .filter((l) => Number.isInteger(l.qty) && l.qty > 0),
    [laundryItems, laundryQty]
  );
  const laundryTotalCents = useMemo(
    () => laundryLines.reduce((s, l) => s + l.f.priceCents * l.qty, 0),
    [laundryLines]
  );

  async function postLaundryTicket() {
    if (laundryLines.length === 0) return;
    try {
      const { data } = await api.post('/api/folios/laundry-sale', {
        items: laundryLines.map((l) => ({ facilityCode: l.f.code, qty: l.qty })),
        guestName: laundryGuest || undefined,
        method: laundryMethod,
      });
      toast.success(`Laundry ticket posted — ${formatPeso(data.totalCents)}.`);
      setLaundryQty({});
      setLaundryGuest('');
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
```

- [ ] **Step 3: Add the laundry-ticket panel**

Add a panel after the visitor-sale panel, visible to the same roles (`canSell`):

```jsx
      {canSell && laundryItems.length > 0 && (
        <div className="panel">
          <h3>Laundry ticket</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Priced per piece. Enter how many of each garment; the whole ticket posts as one charge.
          </p>
          <table>
            <thead>
              <tr>
                <th>Garment</th>
                <th>Price / piece</th>
                <th>Pieces</th>
                <th>Line total</th>
              </tr>
            </thead>
            <tbody>
              {laundryItems.map((f) => {
                const qty = Number(laundryQty[f.code] || 0);
                return (
                  <tr key={f.code}>
                    <td>{f.name}</td>
                    <td>{formatPeso(f.priceCents)}</td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        style={{ width: 80 }}
                        value={laundryQty[f.code] ?? ''}
                        onChange={(e) => setLaundryQty((p) => ({ ...p, [f.code]: e.target.value }))}
                      />
                    </td>
                    <td>{qty > 0 ? formatPeso(f.priceCents * qty) : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
            <div>
              <label>Visitor name (optional)</label>
              <input value={laundryGuest} onChange={(e) => setLaundryGuest(e.target.value)} />
            </div>
            <div>
              <label>Payment method</label>
              <select value={laundryMethod} onChange={(e) => setLaundryMethod(e.target.value)}>
                {METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, textAlign: 'right', fontWeight: 600 }}>
              Ticket total: {formatPeso(laundryTotalCents)}
            </div>
            <div>
              <button onClick={postLaundryTicket} disabled={laundryLines.length === 0}>
                Post laundry ticket
              </button>
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 4: Verify the build**

Run: `cd web && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Verify live**

Rebuild the web image, then in the browser: the amenities table shows `HALL_A/B/C` indented under the Grand Function Hall; the laundry panel lists the per-piece garments; entering 2 polos + 1 long-sleeve shows a ₱550.00 ticket total; posting it succeeds and the resulting folio carries **one** `LD` charge described `Laundry: 2× Polo, 1× Long-sleeve shirt`.

Confirm via the database:

```bash
docker exec innsightpms-postgres-1 psql -U innsight -d innsight_folio -c \
  "SELECT \"chargeCode\", description, \"amountCents\", quantity FROM \"FolioTransaction\" WHERE \"chargeCode\"='LD' ORDER BY \"postedAt\" DESC LIMIT 3;"
```

Also confirm the sale reaches the night audit's other-revenue figure, closing the loop with Task 1:

```bash
docker exec innsightpms-postgres-1 psql -U innsight -d innsight_folio -c \
  "SELECT SUM(\"amountCents\") FROM \"FolioTransaction\" WHERE type='CHARGE' AND \"chargeCode\"='LD' AND \"postedAt\" >= CURRENT_DATE;"
```
