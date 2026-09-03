# Reservation & Dashboard Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the four "Reservation & Dashboard Updates" requirements from the capstone panel's change list: a length-of-stay indicator on the calendar, a real itemized guest folio/receipt, a broader hotel-terminology copy sweep, and a reservation add-on (special request + surcharge) feature.

**Architecture:** Each of the four items is close to self-contained. The calendar change is frontend-only. The receipt rewrite adds one new cross-service JSON endpoint (stay-by-id) and rebuilds the existing PDF route to pull guest/stay/reservation data together. The add-on feature adds one small generic settings table plus a JSON column on `Reservation`, computed server-side and later posted to the folio as a normal `CHARGE` transaction when the stay checks in — reusing the existing `room:checkin` event flow rather than adding a new one.

**Tech Stack:** Node.js/Express/Prisma/PostgreSQL microservices (`services/reservation`, `services/folio`, `services/stay`), React/Vite frontend (`web/`), Redis pub/sub for cross-service events, `pdfkit` for PDF rendering, Node's built-in `node:test` runner (no Jest/Vitest in this repo).

**Spec:** `docs/superpowers/specs/2026-08-17-reservation-dashboard-updates-design.md`

## Global Constraints

- All money values are integer cents (`BigInt` in Prisma columns, plain numbers inside JSON blobs) — never floats. Use `formatPeso`/`pesosToCents`/`centsToPesos` from `web/src/lib/money.js` on the frontend.
- The `IN_HOUSE` reservation/stay status enum, the `CANCELLED` (double-L) status spelling, and the `FRONT_DESK` role spelling are canonical and must never be touched by the terminology sweep (Task 4) or any other task — only user-facing display copy changes.
- Every new or modified Express route MUST carry a `requireRole(...)` guard. Each service's `routes/authz.test.js` walks the router and fails the build if ANY route lacks one — there are no exceptions to add it to an "OPEN" allow-list for these tasks.
- **Migration SQL must be idempotent** (`IF NOT EXISTS` / `ON CONFLICT ... DO NOTHING`). `scripts/db-init.sh` re-applies every non-baseline migration file via `prisma db execute` on **every container start**, regardless of whether the service booted via `prisma migrate deploy` or `prisma db push`. A plain `ALTER TABLE ... ADD COLUMN` without `IF NOT EXISTS` will crash the container the second time it starts.
- Cross-service reads (guest/stay/reservation lookups from another service) must be best-effort: wrap in try/catch, apply `AbortSignal.timeout(...)`, and degrade to `null`/`'—'` rather than fail the whole request — this repo's established convention (see `services/folio/src/routes/folio.routes.js`'s existing inventory lookup, `services/audit/src/routes/audit.routes.js`'s `callService`).

---

### Task 1: Calendar — length-of-stay indicator

**Files:**
- Create: `web/src/lib/calendarBands.js`
- Create: `web/src/lib/calendarBands.test.js`
- Modify: `web/src/pages/Calendar.jsx` (bar rendering block, ~line 442; legend block, ~lines 486-501)
- Modify: `web/src/styles.css` (append after the existing `.cal2-legend .swatch.pending` rule, ~line 1256)

**Interfaces:**
- Produces: `stayLengthBand(nights: number): 'short' | 'medium' | 'long'` — pure function, no dependencies.

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/calendarBands.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';

import { stayLengthBand } from './calendarBands.js';

test('bands 1-2 nights as short', () => {
  assert.equal(stayLengthBand(1), 'short');
  assert.equal(stayLengthBand(2), 'short');
});

test('bands 3-6 nights as medium', () => {
  assert.equal(stayLengthBand(3), 'medium');
  assert.equal(stayLengthBand(6), 'medium');
});

test('bands 7+ nights as long', () => {
  assert.equal(stayLengthBand(7), 'long');
  assert.equal(stayLengthBand(30), 'long');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --test src/lib/calendarBands.test.js`
Expected: FAIL — `calendarBands.js` does not exist yet (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `web/src/lib/calendarBands.js`:

```js
// Length-of-stay banding for the calendar's secondary color cue (Changes-to-
// be-made doc, item 1). Deliberately independent of status color, which
// encodes reservation state and must not be touched by this.
export function stayLengthBand(nights) {
  if (nights <= 2) return 'short';
  if (nights <= 6) return 'medium';
  return 'long';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && node --test src/lib/calendarBands.test.js`
Expected: PASS (3 tests, 6 assertions).

- [ ] **Step 5: Wire the stripe into the calendar bar**

In `web/src/pages/Calendar.jsx`, add the import near the other `lib` imports (alongside the existing `formatPeso`/`pesosToCents` import):

```js
import { stayLengthBand } from '../lib/calendarBands';
```

Find the bar's rendered `<div>` (the one with `className={cls}`, currently starting around line 442). Add a stripe `<span>` as its first child, before the existing `{b.balanceDue && <span className="bar-balance-dot" />}` line:

```jsx
<span className={`cal2-bar-stripe stay-${stayLengthBand(b.span)}`} />
{b.balanceDue && <span className="bar-balance-dot" />}
```

- [ ] **Step 6: Add the legend entries**

In the existing legend block (`web/src/pages/Calendar.jsx`, the `<span><span className="swatch pending" /> Pending</span>` block around line 498-500), add three more entries immediately after it:

```jsx
<span>
  <span className="swatch pending" /> Pending
</span>
<span style={{ marginLeft: 12 }}>
  <span className="swatch stay-short" /> 1–2 nights
</span>
<span>
  <span className="swatch stay-medium" /> 3–6 nights
</span>
<span>
  <span className="swatch stay-long" /> 7+ nights
</span>
```

- [ ] **Step 7: Add the CSS**

In `web/src/styles.css`, immediately after the existing `.cal2-legend .swatch.pending { background: #fbbf24; }` rule, add:

```css
.cal2-bar-stripe {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  border-radius: 4px 0 0 4px;
}
.cal2-bar-stripe.stay-short {
  background: #bfdbfe;
}
.cal2-bar-stripe.stay-medium {
  background: #3b82f6;
}
.cal2-bar-stripe.stay-long {
  background: #1e3a8a;
}
.cal2-legend .swatch.stay-short {
  background: #bfdbfe;
}
.cal2-legend .swatch.stay-medium {
  background: #3b82f6;
}
.cal2-legend .swatch.stay-long {
  background: #1e3a8a;
}
```

- [ ] **Step 8: Verify the build and check visually**

Run: `cd web && npm run build`
Expected: build succeeds with no errors.

Start the dev stack, open the Calendar page, and confirm: every reservation bar still shows its status color as the fill, each now has a thin left-edge stripe colored by nights (1-2 = light blue, 3-6 = medium blue, 7+ = dark blue), and the legend shows the three new swatches.

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/calendarBands.js web/src/lib/calendarBands.test.js web/src/pages/Calendar.jsx web/src/styles.css
git commit -m "feat: add length-of-stay stripe to reservation calendar bars"
```

---

### Task 2: Stay service — add `GET /api/stays/:id`

**Files:**
- Modify: `services/stay/src/routes/stay.routes.js` (add a new route after the existing `GET /stays` list route, ~line 460, before `GET /stays/:id/registration-card`)

**Interfaces:**
- Produces: `GET /api/stays/:id` → `200 { id, reservationId, guestId, assignedRoomId, folioId, actualCheckInAt, actualCheckOutAt, status, keyCardsIssued, idVerification, depositAmount, guestName, expectedCheckIn, expectedCheckOut, createdAt, updatedAt }` (raw `Stay` row) or `404 { error }`. Guarded by `ROLE_GROUPS.DESK_AUDIT`.
- Consumed by: Task 3 (folio print route).

- [ ] **Step 1: Add the route**

In `services/stay/src/routes/stay.routes.js`, immediately after the existing `router.get('/stays', requireRole(...ROLE_GROUPS.DESK_AUDIT), ...)` handler block (ends around line 460) and before `router.get('/stays/:id/registration-card', ...)`, add:

```js
// GET /api/stays/:id — single stay by id, JSON. Added for the folio print
// route (Changes-to-be-made doc, item 2), which needs actual arrival/departure
// times and the reservationId for a given folio's stayId.
router.get('/stays/:id', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const stay = await prisma.stay.findUnique({ where: { id: req.params.id } });
    if (!stay) return res.status(404).json({ error: 'Not found.' });
    res.json(stay);
  } catch (err) {
    console.error('[Stay] Get error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});
```

- [ ] **Step 2: Confirm the authorization audit still passes**

Run: `cd services/stay && node --test src/routes/authz.test.js`
Expected: PASS — the new route carries `requireRole(...ROLE_GROUPS.DESK_AUDIT)`, so the default-deny audit in `authz.test.js` (which walks every route on the router) passes without needing any changes to that test file.

- [ ] **Step 3: Manually verify against the running dev stack**

With the dev stack up and a valid staff JWT (`TOKEN`) and a real stay id (`STAY_ID`) from `GET /api/stays?status=IN_HOUSE`:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3006/api/stays/$STAY_ID | head -c 500
```

Expected: a JSON object with `id`, `reservationId`, `actualCheckInAt`, etc. A bogus id returns `{"error":"Not found."}` with HTTP 404.

- [ ] **Step 4: Commit**

```bash
git add services/stay/src/routes/stay.routes.js
git commit -m "feat: add GET /api/stays/:id for cross-service stay lookups"
```

---

### Task 3: Folio service — rebuild the guest folio print route

**Files:**
- Create: `services/folio/src/lib/receiptWords.js`
- Create: `services/folio/src/lib/receiptWords.test.js`
- Create: `services/folio/src/lib/folioSummary.js`
- Create: `services/folio/src/lib/folioSummary.test.js`
- Modify: `services/folio/src/routes/folio.routes.js` (top constants ~lines 12-24; replace the `GET /folios/:id/print` route, ~lines 855-931)
- Modify: `docker-compose.yml` (folio-service `environment:` block, ~lines 154-160)

**Interfaces:**
- Consumes: `GET /api/stays/:id` from Task 2 (`{ actualCheckInAt, actualCheckOutAt, guestName, reservationId }`); existing `GET /api/guests/:id` (`{ nationality }`); existing `GET /api/reservations/:id` (`{ adults, children, confirmationNumber, checkIn, checkOut, nights, guestName }`).
- Produces: `centsToWords(amountCents: number|bigint): string`; `classifyTransactions(transactions: Array<{type, amountCents, taxAmountCents, chargeCode}>, roomCodes: Set<string>): { roomChargeCents, extraChargeCents, taxCents, totalChargesCents, paymentsCents, refundsCents, netPaymentsCents, adjustmentsCents, balanceCents }` (all bigint fields).

- [ ] **Step 1: Write the failing test for `centsToWords`**

Create `services/folio/src/lib/receiptWords.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { centsToWords } = require('./receiptWords');

test('spells out a reference amount exactly (₱35,029.50)', () => {
  assert.equal(centsToWords(3502950), 'THIRTY-FIVE THOUSAND TWENTY-NINE AND FIFTY');
});

test('zero amount', () => {
  assert.equal(centsToWords(0), 'ZERO ONLY');
});

test('whole pesos, no centavos', () => {
  assert.equal(centsToWords(10000), 'ONE HUNDRED ONLY');
});

test('centavos only, under one peso', () => {
  assert.equal(centsToWords(150), 'ONE AND FIFTY');
});

test('accepts a BigInt (as Prisma returns for amountCents columns)', () => {
  assert.equal(centsToWords(3502950n), 'THIRTY-FIVE THOUSAND TWENTY-NINE AND FIFTY');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/folio && node --test src/lib/receiptWords.test.js`
Expected: FAIL — `receiptWords.js` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `services/folio/src/lib/receiptWords.js`:

```js
// Spell out a peso amount for the "Amount in Words" line on a printed guest
// folio, matching the wording convention hotel folio templates use (e.g.
// "THIRTY-FIVE THOUSAND TWENTY-NINE AND FIFTY" for ₱35,029.50).
const ONES = [
  'ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
  'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
];
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];
const SCALES = ['', 'THOUSAND', 'MILLION', 'BILLION'];

function threeDigitsToWords(n) {
  const parts = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} HUNDRED`);
    n %= 100;
  }
  if (n >= 20) {
    const tens = TENS[Math.floor(n / 10)];
    const ones = n % 10;
    parts.push(ones ? `${tens}-${ONES[ones]}` : tens);
  } else if (n > 0) {
    parts.push(ONES[n]);
  }
  return parts.join(' ');
}

function integerToWords(n) {
  if (n === 0) return 'ZERO';
  const groups = [];
  let rest = n;
  let scaleIdx = 0;
  while (rest > 0) {
    const chunk = rest % 1000;
    if (chunk > 0) {
      const scale = SCALES[scaleIdx];
      groups.unshift(scale ? `${threeDigitsToWords(chunk)} ${scale}` : threeDigitsToWords(chunk));
    }
    rest = Math.floor(rest / 1000);
    scaleIdx += 1;
  }
  return groups.join(' ');
}

// amountCents may be a Number or a BigInt (Prisma returns BigInt for
// amountCents columns). Number() safely widens it — no hotel folio approaches
// Number.MAX_SAFE_INTEGER.
function centsToWords(amountCents) {
  const totalCents = Math.round(Number(amountCents));
  const sign = totalCents < 0 ? '-' : '';
  const abs = Math.abs(totalCents);
  const pesos = Math.floor(abs / 100);
  const centavos = abs % 100;
  const centavosWords = centavos > 0 ? ` AND ${threeDigitsToWords(centavos)}` : ' ONLY';
  return `${sign}${integerToWords(pesos)}${centavosWords}`;
}

module.exports = { centsToWords };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/folio && node --test src/lib/receiptWords.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing test for transaction classification**

Create `services/folio/src/lib/folioSummary.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { classifyTransactions } = require('./folioSummary');

const ROOM_CODES = new Set(['RM']);

test('classifies a room charge with tax, plus a payment', () => {
  const result = classifyTransactions(
    [
      { type: 'CHARGE', chargeCode: 'RM', amountCents: 500000n, taxAmountCents: 60000n },
      { type: 'PAYMENT', chargeCode: null, amountCents: 300000n, taxAmountCents: 0n },
    ],
    ROOM_CODES
  );
  assert.equal(result.roomChargeCents, 500000n);
  assert.equal(result.extraChargeCents, 0n);
  assert.equal(result.taxCents, 60000n);
  assert.equal(result.totalChargesCents, 560000n);
  assert.equal(result.netPaymentsCents, 300000n);
  assert.equal(result.balanceCents, 260000n);
});

test('a non-room charge code is classified as an extra charge', () => {
  const result = classifyTransactions(
    [{ type: 'CHARGE', chargeCode: 'MB', amountCents: 15000n, taxAmountCents: 0n }],
    ROOM_CODES
  );
  assert.equal(result.roomChargeCents, 0n);
  assert.equal(result.extraChargeCents, 15000n);
});

test('a refund reduces net payments, not total charges', () => {
  const result = classifyTransactions(
    [
      { type: 'PAYMENT', chargeCode: null, amountCents: 100000n, taxAmountCents: 0n },
      { type: 'REFUND', chargeCode: null, amountCents: 20000n, taxAmountCents: 0n },
    ],
    ROOM_CODES
  );
  assert.equal(result.paymentsCents, 100000n);
  assert.equal(result.refundsCents, 20000n);
  assert.equal(result.netPaymentsCents, 80000n);
});

test('a negative adjustment (a credit) reduces the balance', () => {
  const result = classifyTransactions(
    [
      { type: 'CHARGE', chargeCode: 'RM', amountCents: 100000n, taxAmountCents: 0n },
      { type: 'ADJUSTMENT', chargeCode: null, amountCents: -50000n, taxAmountCents: 0n },
    ],
    ROOM_CODES
  );
  assert.equal(result.adjustmentsCents, -50000n);
  assert.equal(result.balanceCents, 50000n);
});

test('empty transaction list is all zeros', () => {
  const result = classifyTransactions([], ROOM_CODES);
  assert.equal(result.totalChargesCents, 0n);
  assert.equal(result.balanceCents, 0n);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd services/folio && node --test src/lib/folioSummary.test.js`
Expected: FAIL — `folioSummary.js` does not exist yet.

- [ ] **Step 7: Write minimal implementation**

Create `services/folio/src/lib/folioSummary.js`:

```js
// Pure classification of a folio's transactions into the sections a printed
// guest receipt shows. No Prisma, no HTTP, no pdfkit, so the arithmetic that
// decides what a guest is billed can be unit-tested without a database.
//
// roomCodes: a Set of ChargeCode.code values whose category is 'ROOM'. Room
// revenue is classified by the charge code's category, not a hardcoded
// string — the seeded room code is 'RM', not 'ROOM' (see the identical
// convention in the daily-totals route in folio.routes.js).
function classifyTransactions(transactions, roomCodes) {
  let roomChargeCents = 0n;
  let extraChargeCents = 0n;
  let taxCents = 0n;
  let paymentsCents = 0n;
  let refundsCents = 0n;
  let adjustmentsCents = 0n;

  for (const tx of transactions) {
    const amount = BigInt(tx.amountCents);
    const tax = BigInt(tx.taxAmountCents || 0);
    if (tx.type === 'CHARGE') {
      if (roomCodes.has(tx.chargeCode)) roomChargeCents += amount;
      else extraChargeCents += amount;
      taxCents += tax;
    } else if (tx.type === 'PAYMENT') {
      paymentsCents += amount;
    } else if (tx.type === 'REFUND') {
      refundsCents += amount;
    } else if (tx.type === 'ADJUSTMENT') {
      adjustmentsCents += amount; // may be negative — a credit
    }
    // A standalone TAX-type transaction is never actually created anywhere in
    // this codebase (tax always rides on a CHARGE's taxAmountCents), so there
    // is deliberately no branch for it here.
  }

  const totalChargesCents = roomChargeCents + extraChargeCents + taxCents;
  // Mirrors the balance formula in the daily-totals endpoint and the original
  // print route: a refund reduces net payments taken; a positive adjustment
  // increases what's owed, a negative one (a credit) reduces it.
  const netPaymentsCents = paymentsCents - refundsCents;
  const balanceCents = totalChargesCents - netPaymentsCents + adjustmentsCents;

  return {
    roomChargeCents,
    extraChargeCents,
    taxCents,
    totalChargesCents,
    paymentsCents,
    refundsCents,
    netPaymentsCents,
    adjustmentsCents,
    balanceCents,
  };
}

module.exports = { classifyTransactions };
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd services/folio && node --test src/lib/folioSummary.test.js`
Expected: PASS (5 tests).

- [ ] **Step 9: Add the new service URL constants and broaden the service token**

In `services/folio/src/routes/folio.routes.js`, right after the existing `const INVENTORY_URL = process.env.INVENTORY_URL || 'http://inventory-service:3005';` (line 12), add:

```js
const GUEST_URL = process.env.GUEST_URL || 'http://guest-service:3008';
const STAY_URL = process.env.STAY_URL || 'http://stay-service:3006';
const RESERVATION_URL = process.env.RESERVATION_URL || 'http://reservation-service:3011';
```

Then extend the existing `serviceToken()` function's `permissions` array (currently `['room.read', 'rateplan.read']`, ~line 20) to also list the new reads:

```js
    permissions: ['room.read', 'rateplan.read', 'guest.read', 'stay.read', 'reservation.read'],
```

Immediately after the `serviceToken()` function, add a shared best-effort fetch helper:

```js
// Best-effort cross-service GET. A failed lookup returns null instead of
// throwing — the print route degrades a field to "—" rather than failing the
// whole print, since staff need folios to print during an audit even if
// another service is degraded.
async function fetchJsonOrNull(url) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${serviceToken()}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
```

- [ ] **Step 10: Import the new helpers**

At the top of `services/folio/src/routes/folio.routes.js`, alongside the existing `const { requireRole, ROLE_GROUPS, signServiceToken } = require('../middleware/auth');`, add:

```js
const { centsToWords } = require('../lib/receiptWords');
const { classifyTransactions } = require('../lib/folioSummary');
```

- [ ] **Step 11: Replace the print route**

Replace the entire existing `GET /api/folios/:id/print` route (from `// GET /api/folios/:id/print  — renders folio statement as PDF` through its closing `});`, currently the second-to-last block in the file, right before `module.exports = router;`) with:

```js
// GET /api/folios/:id/print — renders a guest folio/receipt as PDF, formatted
// to match the panel's reference invoice (Changes-to-be-made doc, item 2).
router.get('/folios/:id/print', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const folio = await prisma.folio.findUnique({
      where: { id: req.params.id },
      include: { transactions: { orderBy: { postedAt: 'asc' } } },
    });
    if (!folio) return res.status(404).json({ error: 'Not found.' });

    const roomCodes = new Set(
      (await prisma.chargeCode.findMany({ where: { category: 'ROOM' }, select: { code: true } })).map(
        (c) => c.code
      )
    );
    const summary = classifyTransactions(folio.transactions, roomCodes);

    const guest = folio.guestId
      ? await fetchJsonOrNull(`${GUEST_URL}/api/guests/${encodeURIComponent(folio.guestId)}`)
      : null;
    const stay = folio.stayId
      ? await fetchJsonOrNull(`${STAY_URL}/api/stays/${encodeURIComponent(folio.stayId)}`)
      : null;
    const reservation = stay?.reservationId
      ? await fetchJsonOrNull(`${RESERVATION_URL}/api/reservations/${encodeURIComponent(stay.reservationId)}`)
      : null;

    const nights = reservation?.nights || 1;
    const tariffCents = summary.roomChargeCents / BigInt(nights);
    const guestName = stay?.guestName || reservation?.guestName || '—';
    const money = (cents) => `${folio.currency} ${(Number(cents) / 100).toFixed(2)}`;
    const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');
    const fmtTime = (d) => (d ? new Date(d).toISOString().slice(11, 16) : '—');
    const fmtDateTime = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—');

    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="folio-${folio.folioNumber}.pdf"`);
    doc.pipe(res);

    // ── Header ──
    doc.fontSize(18).text('InnSight PMS', { align: 'center' });
    doc.fontSize(11).fillColor('#555').text('Guest Folio', { align: 'center' });
    doc.moveDown(0.8).fillColor('black');

    // ── Guest / stay grid ──
    // No "G.R. Card No." row: InnSight has no physical registration-card
    // concept, so the confirmation number stands in for it. No guest address
    // line: not a field this system captures.
    const row = (label, value) => {
      doc.font('Helvetica-Bold').fontSize(9).text(label, { continued: true, width: 150 });
      doc.font('Helvetica').text(`  ${value ?? '—'}`);
    };
    row('Folio No.:', folio.folioNumber);
    row('Date:', fmtDate(new Date()));
    row('Guest Name:', guestName);
    row('Nationality:', guest?.nationality || '—');
    row('No. of Pax:', reservation ? reservation.adults + reservation.children : '—');
    row('Adult / Child:', reservation ? `${reservation.adults} / ${reservation.children}` : '—');
    row('Confirmation No.:', reservation?.confirmationNumber || '—');
    row('Date of Arrival:', fmtDate(stay?.actualCheckInAt || reservation?.checkIn));
    row('Date of Departure:', fmtDate(stay?.actualCheckOutAt || reservation?.checkOut));
    row('Time of Arrival:', fmtTime(stay?.actualCheckInAt));
    row('Tariff:', money(tariffCents));
    doc.moveDown();

    // ── Particulars ──
    // No Tax1-4 slots and no separate "Transferred From/To Folio" sections:
    // InnSight tracks one combined taxAmountCents per charge (not a
    // decomposed VAT/service-charge/local-tax breakdown), and folio-to-folio
    // transfer isn't a supported workflow here — both are honest deviations
    // from the literal reference template, documented in the design spec.
    doc.fontSize(11).text('Particulars', { underline: true });
    doc.moveDown(0.3);
    const line = (label, value, opts = {}) => {
      doc.fontSize(9).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica');
      doc.text(label, 60, doc.y, { continued: true, width: 380 });
      doc.text(value, { align: 'right' });
    };
    line('Room Charges', money(summary.roomChargeCents));
    line('Add: Taxes', money(summary.taxCents));
    line('Add: Extra Charges', money(summary.extraChargeCents));
    doc.moveDown(0.3);
    line('Total Charges', money(summary.totalChargesCents), { bold: true });
    doc.moveDown(0.3);
    line('Less: Payments', money(summary.paymentsCents));
    if (summary.refundsCents > 0n) line('Less: Refunds', `-${money(summary.refundsCents)}`);
    line('Adjustments', money(summary.adjustmentsCents));
    doc.moveDown(0.3);
    doc.moveTo(48, doc.y).lineTo(547, doc.y).stroke();
    doc.moveDown(0.3);
    line('Balance', money(summary.balanceCents), { bold: true });
    doc.moveDown();

    doc.fontSize(9).font('Helvetica-Bold').text(`This Folio is in: ${folio.currency}`);
    doc.font('Helvetica').text(`Amount in Words: ${centsToWords(summary.balanceCents)}`);
    doc.moveDown();

    doc
      .fontSize(8)
      .fillColor('#555')
      .text(
        'NOTICE TO GUESTS: This property is privately owned and the management reserves the right to ' +
          'refuse service to anyone. Management will not be responsible for accidents or injury to guests ' +
          'or for loss of money, jewelry or valuables of any kind. Management will not be responsible for ' +
          'any item left in the room.',
        { align: 'justify' }
      );
    doc.moveDown(0.5);
    doc.fillColor('#888').text(`Printed ${fmtDateTime(new Date())} — InnSight PMS`, { align: 'center' });

    doc.end();
  } catch (err) {
    console.error('[Folio] Print error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
  }
});
```

- [ ] **Step 12: Add the three new env vars to docker-compose**

In `docker-compose.yml`, in the `folio-service:` block's `environment:` section (currently `DATABASE_URL`, `JWT_SECRET`, `SERVICE_JWT_SECRET`, `PORT`, `REDIS_URL`, `TZ`), add:

```yaml
      GUEST_URL: http://guest-service:3008
      STAY_URL: http://stay-service:3006
      RESERVATION_URL: http://reservation-service:3011
```

- [ ] **Step 13: Confirm the authorization audit still passes**

Run: `cd services/folio && node --test src/routes/authz.test.js`
Expected: PASS — the print route's guard (`requireRole(...ROLE_GROUPS.DESK_AUDIT)`) is unchanged.

- [ ] **Step 14: Manually verify against the running dev stack**

Restart the folio-service container (env vars changed) and stay-service (Task 2's route), then:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3007/api/folios/$FOLIO_ID/print -o /tmp/folio-test.pdf
open /tmp/folio-test.pdf   # or xdg-open on Linux
```

Expected: a PDF with the hotel header, guest/stay grid (guest name, nationality if on file, pax/adult-child counts, confirmation number, arrival/departure, tariff), a Particulars section with Room Charges / Taxes / Extra Charges / Total Charges / Payments / Adjustments / Balance, an Amount in Words line matching the Balance figure, and the notice footer. Try a folio whose guest/stay lookups would 404 (e.g. temporarily wrong `guestId`) and confirm the PDF still renders with `—` in place of the missing fields instead of erroring.

- [ ] **Step 15: Commit**

```bash
git add services/folio/src/lib/receiptWords.js services/folio/src/lib/receiptWords.test.js \
  services/folio/src/lib/folioSummary.js services/folio/src/lib/folioSummary.test.js \
  services/folio/src/routes/folio.routes.js docker-compose.yml
git commit -m "feat: rebuild guest folio print route to match reference invoice format"
```

---

### Task 4: Terminology sweep

**Files:**
- Create (scratch, not committed): a candidate list for review — save wherever convenient, e.g. `/tmp/terminology-sweep.md`
- Modify: whichever `web/src/**/*.jsx` files the approved list covers

**Interfaces:** none — this is a copy-only change with a human review gate.

- [ ] **Step 1: Generate the candidate list**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
grep -rn "in-house" web/src --include="*.jsx" -i
```

For each hit, note whether it's user-visible copy (a JSX text node, a label, a `title=`/`placeholder=`/`aria-label` attribute) or a code identifier (a CSS class name, a JS variable, a prop name derived from the `IN_HOUSE` status). Only the former are candidates.

Then broaden the search for other non-standard hotel terminology in the same files (labels, headings, button text, tooltips) — e.g. informal phrasing that a professional PMS wouldn't use. Read through `web/src/pages/*.jsx` guest- and reservation-facing pages (`Reservations.jsx`, `ReservationDetail.jsx`, `Calendar.jsx`, `Arrivals.jsx`, `Guests.jsx`, `WalkIn.jsx`) for candidates. Compile a table: current wording | proposed wording | file:line | rationale.

- [ ] **Step 2: Present the list for review**

Show the compiled table to the user. Do not proceed to Step 3 until they've approved it (in full or with edits) — this is a hard gate, not a formality, since terminology judgment calls are inherently subjective and the whole point of this task is avoiding an unreviewed bulk find/replace.

- [ ] **Step 3: Apply the approved changes**

For each approved row, edit the exact file:line. Do not touch the `IN_HOUSE` enum, any `status === 'IN_HOUSE'` comparison, any CSS class named `in_house`/`in-house`, or any other code identifier — only literal user-facing text.

- [ ] **Step 4: Verify the build**

Run: `cd web && npm run build`
Expected: build succeeds with no errors (a pure copy change should never break the build, but this confirms no stray syntax was introduced editing JSX text nodes).

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "fix: correct hotel terminology in user-facing copy"
```

---

### Task 5: Reservation service — add-on settings & data model

**Files:**
- Modify: `services/reservation/src/prisma/schema.prisma` (add `AppSetting` model; add `addOns` field to `Reservation`)
- Create: `services/reservation/src/prisma/migrations/20260817000100_add_ons_and_settings/migration.sql`
- Create: `services/reservation/src/lib/addOns.js`
- Create: `services/reservation/src/lib/addOns.test.js`
- Modify: `services/reservation/src/routes/reservation.routes.js` (imports; `POST /reservations` handler, ~lines 85-108; append two new routes near the end, before `module.exports`)
- Modify: `services/reservation/src/seed.js` (not required for already-seeded DBs, but keep fresh-install seed data consistent — see Step 8)

**Interfaces:**
- Produces: `computeAddOns(rawAddOns: Array<{description, costCents}>, feePercent: number): Array<{description, costCents, feePercent, totalCents}>` (pure); `GET /api/settings/addon-fee-percent` → `{ feePercent: number }`; `PUT /api/settings/addon-fee-percent` (body `{ feePercent }`, `ROLE_GROUPS.MGMT`-only) → `{ feePercent: number }`; `Reservation.addOns: Json?` — an array of the enriched objects above, frozen at creation time.
- Consumed by: Task 6 (frontend wizard), Task 7 (folio subscriber).

- [ ] **Step 1: Write the failing test for the pure add-on computation**

Create `services/reservation/src/lib/addOns.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { computeAddOns } = require('./addOns');

test('applies the fee percentage to the staff-entered cost', () => {
  const result = computeAddOns([{ description: 'Specific brand of cake', costCents: 85000 }], 10);
  assert.deepEqual(result, [
    { description: 'Specific brand of cake', costCents: 85000, feePercent: 10, totalCents: 93500 },
  ]);
});

test('rounds a fractional total to the nearest cent', () => {
  const result = computeAddOns([{ description: 'X', costCents: 999 }], 7.5);
  // 999 * 1.075 = 1073.925 → rounds to 1074
  assert.equal(result[0].totalCents, 1074);
});

test('filters out entries with a blank description', () => {
  const result = computeAddOns([{ description: '   ', costCents: 1000 }], 10);
  assert.deepEqual(result, []);
});

test('clamps a negative or missing cost to zero', () => {
  const result = computeAddOns([{ description: 'Y', costCents: -500 }, { description: 'Z' }], 10);
  assert.equal(result[0].costCents, 0);
  assert.equal(result[1].costCents, 0);
});

test('non-array input returns an empty list', () => {
  assert.deepEqual(computeAddOns(null, 10), []);
  assert.deepEqual(computeAddOns(undefined, 10), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/reservation && node --test src/lib/addOns.test.js`
Expected: FAIL — `addOns.js` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `services/reservation/src/lib/addOns.js`:

```js
// Pure helper: given raw staff-entered add-on lines and the CURRENT admin fee
// percentage, compute the frozen totals persisted onto the reservation. Frozen
// at creation time so a later change to the fee percentage never rewrites an
// already-booked guest's total (Changes-to-be-made doc, item 4).
function computeAddOns(rawAddOns, feePercent) {
  if (!Array.isArray(rawAddOns)) return [];
  const pct = Number(feePercent) || 0;
  return rawAddOns
    .filter((a) => a && typeof a.description === 'string' && a.description.trim())
    .map((a) => {
      const costCents = Math.max(0, Math.round(Number(a.costCents) || 0));
      const totalCents = Math.round(costCents * (1 + pct / 100));
      return {
        description: a.description.trim(),
        costCents,
        feePercent: pct,
        totalCents,
      };
    });
}

module.exports = { computeAddOns };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/reservation && node --test src/lib/addOns.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the schema changes**

In `services/reservation/src/prisma/schema.prisma`, add `addOns` to the `Reservation` model right after the existing `specialRequests String?` field:

```prisma
  specialRequests       String?
  addOns                Json?
```

Then add a new model at the end of the file (after `ReservationActivity`):

```prisma
model AppSetting {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt
}
```

- [ ] **Step 6: Write the migration**

Create `services/reservation/src/prisma/migrations/20260817000100_add_ons_and_settings/migration.sql`:

```sql
-- Reservation add-ons (Changes-to-be-made doc, item 4): a special-request line
-- item with a staff-entered cost and an admin-configurable percentage fee,
-- computed and frozen at reservation-creation time so a later fee change
-- never rewrites an existing guest's total.
--
-- IF NOT EXISTS / ON CONFLICT throughout: scripts/db-init.sh re-applies every
-- non-baseline migration file via `prisma db execute` on EVERY container
-- start, on top of whatever `prisma migrate deploy` or `prisma db push`
-- already did — a plain ADD COLUMN without IF NOT EXISTS would crash the
-- second boot.
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "addOns" JSONB;

-- Generic key/value settings store. First user: the add-on fee percentage,
-- admin-editable from the reservation wizard.
CREATE TABLE IF NOT EXISTS "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

INSERT INTO "AppSetting" ("key", "value", "updatedAt")
VALUES ('addon_fee_percent', '10', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
```

- [ ] **Step 7: Apply the migration and regenerate the Prisma client**

Against the running dev database:

```bash
cd services/reservation
npx prisma generate --schema=src/prisma/schema.prisma
npx prisma migrate deploy --schema=src/prisma/schema.prisma
```

Expected: both commands exit 0; `prisma.appSetting` and `reservation.addOns` are now available on the generated client. (If there is no baseline migration yet in this environment, use `npx prisma db push --schema=src/prisma/schema.prisma --skip-generate` instead, per the branching logic in `services/reservation/db-init.sh`.)

- [ ] **Step 8: Add the endpoints**

In `services/reservation/src/routes/reservation.routes.js`, add the import alongside the existing `const { cancellationFeeCents } = require('../lib/policies');`:

```js
const { computeAddOns } = require('../lib/addOns');
```

In the `POST /reservations` handler, add `addOns` to the destructured request body (alongside `specialRequests`, ~line 106):

```js
      specialRequests,
      expectedArrivalTime,
      paymentType,
      ratePlan,
      origin,
      addOns: rawAddOns,
```

Immediately before the `// ── PHASE 1: claim capacity ──` comment, fetch the current fee percentage and compute the enriched add-ons:

```js
    const feeSetting = await prisma.appSetting.findUnique({ where: { key: 'addon_fee_percent' } });
    const enrichedAddOns = computeAddOns(rawAddOns, Number(feeSetting?.value ?? 10));
```

In the `prisma.reservation.create({ data: { ... } })` call, add `addOns: enrichedAddOns,` right after the existing `specialRequests,` line.

Near the end of the file, right before `module.exports = router;` (or, if the file has no explicit `module.exports = router;` line, immediately after the last existing route), add:

```js
// GET /api/settings/addon-fee-percent — read the current add-on surcharge so
// the reservation wizard can show it before checkout.
router.get('/settings/addon-fee-percent', requireRole(...ROLE_GROUPS.DESK), async (req, res) => {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: 'addon_fee_percent' } });
    res.json({ feePercent: Number(row?.value ?? 10) });
  } catch (err) {
    console.error('[Reservation] Get setting error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/settings/addon-fee-percent — admin/manager only.
router.put('/settings/addon-fee-percent', requireRole(...ROLE_GROUPS.MGMT), async (req, res) => {
  try {
    const feePercent = Number(req.body.feePercent);
    if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 100) {
      return res.status(400).json({ error: 'feePercent must be a number between 0 and 100.' });
    }
    const row = await prisma.appSetting.upsert({
      where: { key: 'addon_fee_percent' },
      create: { key: 'addon_fee_percent', value: String(feePercent) },
      update: { value: String(feePercent) },
    });
    res.json({ feePercent: Number(row.value) });
  } catch (err) {
    console.error('[Reservation] Set setting error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});
```

- [ ] **Step 9: Keep fresh-install seed data consistent**

This step doesn't affect already-running databases (the migration in Step 6 covers those) — it only keeps a from-scratch `prisma db push` + `seed.js` install consistent, since `AppSetting`'s default row is inserted by the migration, which a from-scratch install also runs (per `db-init.sh`'s "always re-apply raw-SQL constraints" step). No code change is needed here; this step is a no-op check — confirm by reading `services/reservation/src/seed.js` that it does not create any `AppSetting` rows itself (it shouldn't, and shouldn't need to).

- [ ] **Step 10: Confirm the authorization audit still passes**

Run: `cd services/reservation && node --test src/routes/authz.test.js`
Expected: PASS — both new routes carry `requireRole(...)`.

- [ ] **Step 11: Manually verify against the running dev stack**

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3011/api/settings/addon-fee-percent
# → {"feePercent":10}

curl -s -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"feePercent": 15}' http://localhost:3011/api/settings/addon-fee-percent
# → {"feePercent":15}

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"guestName":"Test Guest","roomTypeCode":"STD","checkIn":"2026-09-01","checkOut":"2026-09-03","addOns":[{"description":"Specific brand of cake","costCents":85000}]}' \
  http://localhost:3011/api/reservations | grep -o '"addOns":\[[^]]*\]'
# → "addOns":[{"description":"Specific brand of cake","costCents":85000,"feePercent":15,"totalCents":97750}]
```

Confirm a non-admin token gets `403` from the `PUT`.

- [ ] **Step 12: Commit**

```bash
git add services/reservation/src/prisma/schema.prisma \
  services/reservation/src/prisma/migrations/20260817000100_add_ons_and_settings \
  services/reservation/src/lib/addOns.js services/reservation/src/lib/addOns.test.js \
  services/reservation/src/routes/reservation.routes.js
git commit -m "feat: add reservation add-ons with admin-configurable percentage fee"
```

---

### Task 6: NewReservation.jsx — Add-ons wizard step

**Files:**
- Modify: `web/src/pages/NewReservation.jsx` (imports; state declarations ~line 20-60; `totals` useMemo ~lines 117-123; `submit()` payload ~lines 162-197; Step 4 JSX ~lines 528-534)

**Interfaces:**
- Consumes: `GET /api/settings/addon-fee-percent` and `PUT /api/settings/addon-fee-percent` from Task 5.

- [ ] **Step 1: Add imports and state**

In `web/src/pages/NewReservation.jsx`, add to the existing imports:

```js
import { useAuth } from '../auth';
```

Inside the component, alongside the existing `const toast = useToast();`, add:

```js
  const { hasRole } = useAuth();
  const isAdmin = hasRole('ADMIN', 'MANAGER');
```

Alongside the existing `// Step 5` state block, add a new block:

```js
  // Step 4 — Add-ons
  const [addOns, setAddOns] = useState([]); // [{ description, costCents }]
  const [addOnDesc, setAddOnDesc] = useState('');
  const [addOnCostPesos, setAddOnCostPesos] = useState('');
  const [feePercent, setFeePercent] = useState(10);
  const [feeEditPesos, setFeeEditPesos] = useState('');
```

- [ ] **Step 2: Fetch the current fee percentage on mount**

Alongside any existing `useEffect` in the component (there is at least one loading availability data on mount), add:

```js
  useEffect(() => {
    api
      .get('/api/settings/addon-fee-percent')
      .then(({ data }) => setFeePercent(data.feePercent))
      .catch(() => {}); // default of 10 already set; a failed fetch just keeps it
  }, []);
```

- [ ] **Step 3: Add add-on management functions**

Near the other step-specific functions (e.g. near `setRoom`), add:

```js
  function addAddOn() {
    const costCents = pesosToCents(addOnCostPesos);
    if (!addOnDesc.trim() || !costCents) return;
    setAddOns((list) => [...list, { description: addOnDesc.trim(), costCents }]);
    setAddOnDesc('');
    setAddOnCostPesos('');
  }
  function removeAddOn(idx) {
    setAddOns((list) => list.filter((_, i) => i !== idx));
  }
  async function saveFeePercent() {
    const pct = Number(feeEditPesos);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
    try {
      const { data } = await api.put('/api/settings/addon-fee-percent', { feePercent: pct });
      setFeePercent(data.feePercent);
      setFeeEditPesos('');
      toast.success('Add-on fee updated.');
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
```

- [ ] **Step 4: Include add-ons in the totals estimate**

Replace the existing `totals` useMemo (lines 117-123) with a version that folds in the add-ons subtotal (each add-on's displayed total uses the CURRENT `feePercent` as an estimate — the authoritative amount is computed server-side at submission in Task 5, and may differ negligibly only if an admin changes the fee between opening the wizard and submitting):

```js
  const addOnsTotalCents = useMemo(
    () => addOns.reduce((s, a) => s + Math.round(a.costCents * (1 + feePercent / 100)), 0),
    [addOns, feePercent]
  );

  const totals = useMemo(() => {
    const subtotalCents = picks.reduce((s, p) => s + p.ratePerNightCents * p.qty * nights, 0);
    const taxCents = Math.round(subtotalCents * 0.12); // 12% VAT placeholder
    const grandTotalCents = subtotalCents + taxCents + addOnsTotalCents;
    const suggestedDepositCents = Math.round(grandTotalCents * 0.5);
    return { subtotalCents, taxCents, grandTotalCents, suggestedDepositCents };
  }, [picks, nights, addOnsTotalCents]);
```

- [ ] **Step 5: Include add-ons in the submit payload**

In `submit()`, add `addOns` to the `payload` object (the raw staff input only — the server recomputes authoritative totals per Task 5, never trusting a client-supplied fee/total):

```js
        // No discount engine yet — record the promo code on the reservation so
        // staff can see and apply it, rather than silently dropping it.
        ...(promoCode ? { specialRequests: `Promo code: ${promoCode}` } : {}),
        ...(addOns.length ? { addOns: addOns.map((a) => ({ description: a.description, costCents: a.costCents })) } : {}),
```

- [ ] **Step 6: Replace the Step 4 stub JSX**

Replace the entire `{/* Step 4 — Add-ons */} ... }` block (lines 528-534) with:

```jsx
      {/* Step 4 — Add-ons */}
      {step === 4 && (
        <div className="panel">
          <h3>Add-ons</h3>
          {addOns.length === 0 && (
            <div className="muted" style={{ padding: 12 }}>
              No add-ons yet. Add a special request below, or skip to the next step to take payment.
            </div>
          )}
          {addOns.map((a, i) => {
            const totalCents = Math.round(a.costCents * (1 + feePercent / 100));
            return (
              <div key={i} className="row" style={{ alignItems: 'center' }}>
                <div style={{ flex: 1 }}>{a.description}</div>
                <div>{formatPeso(a.costCents)}</div>
                <div className="muted">+{feePercent}% fee</div>
                <div>{formatPeso(totalCents)}</div>
                <button className="secondary" onClick={() => removeAddOn(i)}>
                  Remove
                </button>
              </div>
            );
          })}
          <div className="row" style={{ marginTop: 12 }}>
            <div style={{ flex: 1 }}>
              <label>Special request</label>
              <input
                value={addOnDesc}
                placeholder="e.g. specific brand of cake"
                onChange={(e) => setAddOnDesc(e.target.value)}
              />
            </div>
            <div>
              <label>Cost (₱)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={addOnCostPesos}
                onChange={(e) => setAddOnCostPesos(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button onClick={addAddOn} disabled={!addOnDesc.trim() || !pesosToCents(addOnCostPesos)}>
                Add
              </button>
            </div>
          </div>
          {addOns.length > 0 && (
            <div className="row" style={{ marginTop: 8, fontWeight: 600 }}>
              <div style={{ flex: 1 }}>Add-ons total</div>
              <div>{formatPeso(addOnsTotalCents)}</div>
            </div>
          )}
          {isAdmin && (
            <div className="row" style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div className="muted">Current add-on fee: {feePercent}%</div>
              <input
                type="number"
                step="0.1"
                min="0"
                max="100"
                style={{ width: 100 }}
                placeholder={String(feePercent)}
                value={feeEditPesos}
                onChange={(e) => setFeeEditPesos(e.target.value)}
              />
              <button className="secondary" disabled={feeEditPesos === ''} onClick={saveFeePercent}>
                Save fee %
              </button>
            </div>
          )}
        </div>
      )}
```

- [ ] **Step 7: Verify the build**

Run: `cd web && npm run build`
Expected: build succeeds with no errors.

- [ ] **Step 8: Manually verify in the browser**

Start the dev stack, go through New Reservation as a front-desk user: on the Add-ons step, add a line item, confirm the fee-inclusive total displays correctly and the running "Add-ons total" updates; confirm the fee-percent editor is hidden for a non-admin/manager user and visible (and functional) for one; complete the wizard and confirm the created reservation (via `GET /api/reservations/:id`) shows the `addOns` array with `feePercent` and `totalCents` populated.

- [ ] **Step 9: Commit**

```bash
git add web/src/pages/NewReservation.jsx
git commit -m "feat: build out the reservation wizard's Add-ons step"
```

---

### Task 7: Folio service — post add-on charges at check-in

**Files:**
- Modify: `services/folio/src/subscribers/redis.subscriber.js`
- Create: `services/folio/src/prisma/migrations/20260817000100_add_addon_charge_code/migration.sql`
- Modify: `services/folio/src/seed.js` (fresh-install consistency, mirrors Task 5 Step 9)

**Interfaces:**
- Consumes: `GET /api/reservations/:id` (`{ addOns: Array<{description, totalCents}> }`) from Task 5; the existing `room:checkin` Redis event, which already carries `reservationId` (`services/stay/src/routes/stay.routes.js:203`).

- [ ] **Step 1: Add the `AO` charge code**

Create `services/folio/src/prisma/migrations/20260817000100_add_addon_charge_code/migration.sql`:

```sql
-- Add-on / special-request charge code (Changes-to-be-made doc, item 4), so a
-- reservation's add-ons can post as a normal folio CHARGE alongside room and
-- other revenue. seed.js will not reach an already-seeded database (it
-- no-ops once ChargeCode has any rows — see src/seed.js), so this is
-- inserted here instead, and re-applied idempotently by db-init.sh on every
-- container start.
INSERT INTO "ChargeCode" ("code", "name", "category", "glAccount", "taxable", "createdAt")
VALUES ('AO', 'Add-on / Special Request', 'SERVICE', '4220', true, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
```

Apply it against the running dev database:

```bash
cd services/folio
npx prisma migrate deploy --schema=src/prisma/schema.prisma
```

(No `schema.prisma` change and no `prisma generate` needed — the `ChargeCode` model is unchanged; this is a data-only migration, the same pattern `services/reservation`'s `no_double_booking` migration already uses for hand-written, non-schema-diff SQL.)

- [ ] **Step 2: Keep fresh-install seed data consistent**

In `services/folio/src/seed.js`, add the same code to the `CHARGE_CODES` array (this only affects a genuinely from-scratch install where `ChargeCode` has zero rows — Step 1's migration is what reaches already-seeded databases):

```js
const CHARGE_CODES = [
  { code: 'RM', name: 'Room', category: 'ROOM', glAccount: '4000', taxable: true },
  { code: 'FB', name: 'Food & Beverage', category: 'FNB', glAccount: '4100', taxable: true },
  { code: 'MB', name: 'Minibar', category: 'FNB', glAccount: '4110', taxable: true },
  { code: 'LD', name: 'Laundry', category: 'SERVICE', glAccount: '4200', taxable: true },
  { code: 'PK', name: 'Parking', category: 'SERVICE', glAccount: '4210', taxable: true },
  { code: 'DM', name: 'Damage', category: 'MISC', glAccount: '4900', taxable: false },
  { code: 'AO', name: 'Add-on / Special Request', category: 'SERVICE', glAccount: '4220', taxable: true },
];
```

- [ ] **Step 3: Add the reservation lookup helper**

In `services/folio/src/subscribers/redis.subscriber.js`, add near the top (after the existing `const prisma = require('../lib/prisma');`):

```js
const { signServiceToken } = require('../middleware/auth');

const RESERVATION_URL = process.env.RESERVATION_URL || 'http://reservation-service:3011';
const SERVICE_TIMEOUT_MS = Number(process.env.SERVICE_TIMEOUT_MS || 8000);

function serviceToken() {
  return signServiceToken({
    name: 'folio',
    roles: ['MANAGER'],
    permissions: ['reservation.read'],
    expiresIn: '2m',
  });
}

// Best-effort — a failed lookup means no add-on charges post for this
// check-in rather than the check-in event handler crashing.
async function fetchReservationOrNull(reservationId) {
  try {
    const r = await fetch(`${RESERVATION_URL}/api/reservations/${encodeURIComponent(reservationId)}`, {
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${serviceToken()}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (err) {
    console.error(`[Folio] Could not fetch reservation ${reservationId} for add-ons:`, err.message);
    return null;
  }
}
```

- [ ] **Step 4: Post add-on charges when a folio opens at check-in**

Replace the existing `if (channel === 'room:checkin') { ... }` block with:

```js
      if (channel === 'room:checkin') {
        console.log(`[Folio] Opening folio for stay ${data.stayId}`);
        if (data.stayId) {
          let folio = await prisma.folio.findFirst({ where: { stayId: data.stayId, status: 'OPEN' } });
          const isNew = !folio;
          if (isNew) {
            folio = await prisma.folio.create({
              data: {
                folioNumber: nextFolioNumber(),
                stayId: data.stayId,
                guestId: data.guestId,
                type: 'GUEST',
              },
            });
            // Notify stay service so it can backfill stay.folioId
            await publisher.publish(
              'folio:created',
              JSON.stringify({
                folioId: folio.id,
                folioNumber: folio.folioNumber,
                stayId: folio.stayId,
                guestId: folio.guestId,
              })
            );
          }

          // Post any reservation add-ons (Changes-to-be-made doc, item 4) now
          // that a folio exists to charge them to. Reference-keyed and checked
          // before insert so a redelivered event never double-charges — same
          // pattern the night audit uses for its own postings.
          if (data.reservationId) {
            const reservation = await fetchReservationOrNull(data.reservationId);
            const addOns = Array.isArray(reservation?.addOns) ? reservation.addOns : [];
            for (let i = 0; i < addOns.length; i += 1) {
              const addOn = addOns[i];
              const reference = `ADDON-${data.reservationId}-${i}`;
              const already = await prisma.folioTransaction.findFirst({ where: { reference } });
              if (already) continue;
              await prisma.folioTransaction.create({
                data: {
                  folioId: folio.id,
                  type: 'CHARGE',
                  chargeCode: 'AO',
                  description: addOn.description,
                  amountCents: BigInt(Math.round(addOn.totalCents)),
                  postedBy: 'system.reservation-addons',
                  sourceSystem: 'reservation',
                  reference,
                },
              });
            }
          }
        }
      }
```

- [ ] **Step 5: Manually verify against the running dev stack**

Create a reservation with an add-on (per Task 5 Step 11), confirm it, then check the guest in (whichever flow publishes `room:checkin` with that `reservationId`). Then:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3007/api/folios?stayId=$STAY_ID" | grep -o '"chargeCode":"AO"[^}]*'
```

Expected: a `CHARGE` transaction with `chargeCode: "AO"` and `amountCents` equal to the add-on's frozen `totalCents`. Check in a second time (or re-publish the same event) and confirm no duplicate `AO` transaction is created.

- [ ] **Step 6: Commit**

```bash
git add services/folio/src/subscribers/redis.subscriber.js services/folio/src/seed.js \
  services/folio/src/prisma/migrations/20260817000100_add_addon_charge_code
git commit -m "feat: post reservation add-ons as folio charges at check-in"
```
