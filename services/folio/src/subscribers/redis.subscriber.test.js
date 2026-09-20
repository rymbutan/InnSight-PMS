// Regression test for the room:checkin handler in redis.subscriber.js.
//
// WHY THIS FILE EXISTS
// --------------------
// Checking a guest in must never zero out (or simply omit) money already on
// the books, and must not leave the folio balance understated either. Four
// things have to hold at once:
//   1. An OPEN folio already on the stay (e.g. one carrying a pre-arrival
//      advance deposit) is REUSED, never replaced — so its existing
//      transactions and running balance survive the transition untouched.
//   2. A security/advance deposit collected at the desk during check-in
//      (Stay.depositAmount, carried on the room:checkin event as
//      depositAmount) is posted onto the folio as a PAYMENT, so it actually
//      reduces the balance the guest is shown — it used to sit only on the
//      Stay row and never touch the folio at all.
//   3. The FULL stay's room charges post immediately at check-in — one line
//      per reserved night, each priced at totalEstimateCents/nights — rather
//      than leaving the folio at ₱0 until the night audit gets around to
//      charging each night individually. A guest who booked 2 nights at
//      ₱2,800 and checks in on day one owes ₱5,600 right away.
//   4. Each night's charge uses the EXACT SAME reference the night audit
//      checks before charging a stay for that day
//      (`AUDIT-<businessDay>-<stayId>`), so a same-day (or later) audit run
//      finds every one of them already posted and skips them — never a
//      double charge.
//
//   node --test src/subscribers/redis.subscriber.test.js

const test = require('node:test');
const assert = require('node:assert');

// ── In-memory Folio / FolioTransaction / ChargeCode store ──────────────────

const memDb = { folio: new Map(), folioTransaction: [], chargeCode: new Map() };
let seq = 0;

const mockPrisma = {
  folio: {
    findFirst: async ({ where }) => {
      for (const f of memDb.folio.values()) {
        if (where.stayId && f.stayId !== where.stayId) continue;
        if (where.status && f.status !== where.status) continue;
        return f;
      }
      return null;
    },
    create: async ({ data }) => {
      const folio = { id: `folio${(seq += 1)}`, status: 'OPEN', ...data };
      memDb.folio.set(folio.id, folio);
      return folio;
    },
  },
  folioTransaction: {
    findFirst: async ({ where: { reference } }) =>
      memDb.folioTransaction.find((t) => t.reference === reference) || null,
    create: async ({ data }) => {
      const tx = { id: `tx${(seq += 1)}`, ...data };
      memDb.folioTransaction.push(tx);
      return tx;
    },
  },
  chargeCode: {
    findUnique: async ({ where: { code } }) => memDb.chargeCode.get(code) || null,
  },
};

// ── Stubs, installed before the subscriber module loads ────────────────────

require.cache[require.resolve('@prisma/client')] = {
  exports: {
    PrismaClient: function () {
      return mockPrisma;
    },
  },
};

// Captures whatever handler the subscriber registers for the 'message' event,
// and every channel it subscribes to, so the test can drive it directly
// instead of standing up a real Redis server.
let messageHandler = null;
const subscribedChannels = [];
require.cache[require.resolve('ioredis')] = {
  exports: function RedisMock() {
    return {
      subscribe: (...args) => {
        const cb = args.pop();
        subscribedChannels.push(...args);
        cb(null);
      },
      on: (event, handler) => {
        if (event === 'message') messageHandler = handler;
      },
      publish: async () => {},
      disconnect: () => {},
    };
  },
};

require.cache[require.resolve('../middleware/auth')] = {
  exports: { signServiceToken: () => 'test-token' },
};

// Pinned so expected room-charge tax figures never drift with whatever an
// operator last saved — matches the Philippine defaults used elsewhere.
const FIXED_RATES = { vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 };
require.cache[require.resolve('../lib/settingsStore')] = {
  exports: { getTaxRates: async () => ({ ...FIXED_RATES, country: 'PH' }) },
};

// Reservations the mocked reservation service "knows about", keyed by id —
// what fetchReservationOrNull's fetch() call resolves to.
const reservationsById = new Map();
global.fetch = async (url) => {
  const m = /\/api\/reservations\/([^/?]+)/.exec(String(url));
  const id = m && decodeURIComponent(m[1]);
  const reservation = id && reservationsById.get(id);
  if (!reservation) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => reservation };
};

const { startSubscriber } = require('./redis.subscriber');
const { computeTax } = require('../lib/policies');
const { localDay } = require('../lib/date');

function reset() {
  memDb.folio.clear();
  memDb.folioTransaction.length = 0;
  memDb.chargeCode.clear();
  memDb.chargeCode.set('RM', { code: 'RM', name: 'Room Charge', category: 'ROOM', taxable: true });
  reservationsById.clear();
  seq = 0;
  messageHandler = null;
}

async function emit(channel, data) {
  startSubscriber();
  assert.ok(messageHandler, 'subscriber never registered a message handler');
  await messageHandler(channel, JSON.stringify(data));
}

// The exact reference the night audit itself would check/post under for a
// given calendar day and stay — see services/audit/src/routes/audit.routes.js.
function auditRefFor(day, stayId) {
  return `AUDIT-${day}-${stayId}`;
}
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
const TODAY = localDay(new Date());

test('check-in on a stay with no existing folio opens a new one and posts the deposit', async () => {
  reset();
  await emit('room:checkin', { stayId: 's1', guestId: 'g1', depositAmount: 150000 });

  const folio = await mockPrisma.folio.findFirst({ where: { stayId: 's1', status: 'OPEN' } });
  assert.ok(folio, 'a folio should have been opened for the stay');

  const deposits = memDb.folioTransaction.filter((t) => t.folioId === folio.id && t.type === 'PAYMENT');
  assert.strictEqual(deposits.length, 1);
  assert.strictEqual(deposits[0].amountCents, 150000n);
  assert.strictEqual(deposits[0].reference, 'DEPOSIT-CHECKIN-s1');
});

test('check-in reuses an already-OPEN folio and preserves its existing balance', async () => {
  reset();
  // Simulates a folio opened ahead of arrival (e.g. a manually-recorded
  // advance deposit) that already carries a charge and a payment.
  memDb.folio.set('preexisting', { id: 'preexisting', stayId: 's2', status: 'OPEN' });
  memDb.folioTransaction.push(
    {
      id: 'seed-charge',
      folioId: 'preexisting',
      type: 'CHARGE',
      amountCents: 500000n,
      reference: 'SEED-CHARGE',
    },
    {
      id: 'seed-payment',
      folioId: 'preexisting',
      type: 'PAYMENT',
      amountCents: 200000n,
      reference: 'SEED-PAYMENT',
    }
  );

  await emit('room:checkin', { stayId: 's2', guestId: 'g2', depositAmount: 100000 });

  // Still exactly one OPEN folio for the stay — not a second, balance-less one.
  assert.strictEqual(memDb.folio.size, 1);
  const folio = memDb.folio.get('preexisting');
  assert.strictEqual(folio.status, 'OPEN');

  // The pre-existing transactions are untouched.
  assert.ok(memDb.folioTransaction.some((t) => t.reference === 'SEED-CHARGE' && t.amountCents === 500000n));
  assert.ok(memDb.folioTransaction.some((t) => t.reference === 'SEED-PAYMENT' && t.amountCents === 200000n));

  // The check-in deposit is posted on TOP of them, not in place of them.
  const deposit = memDb.folioTransaction.find((t) => t.reference === 'DEPOSIT-CHECKIN-s2');
  assert.ok(deposit);
  assert.strictEqual(deposit.amountCents, 100000n);
  assert.strictEqual(deposit.type, 'PAYMENT');
});

test('a redelivered check-in event never double-posts the deposit', async () => {
  reset();
  await emit('room:checkin', { stayId: 's3', guestId: 'g3', depositAmount: 75000 });
  await emit('room:checkin', { stayId: 's3', guestId: 'g3', depositAmount: 75000 });

  const deposits = memDb.folioTransaction.filter((t) => t.reference === 'DEPOSIT-CHECKIN-s3');
  assert.strictEqual(deposits.length, 1);
});

test('a check-in with no deposit posts no PAYMENT transaction', async () => {
  reset();
  await emit('room:checkin', { stayId: 's4', guestId: 'g4', depositAmount: 0 });

  assert.strictEqual(memDb.folioTransaction.filter((t) => t.type === 'PAYMENT').length, 0);
});

test('a same-day booking checking in for 2 nights is charged the full total (₱2,800 x 2 = ₱5,600)', async () => {
  reset();
  reservationsById.set('dea', {
    id: 'dea',
    nights: 2,
    checkIn: new Date().toISOString(),
    totalEstimateCents: 560000, // ₱2,800.00 x 2
    addOns: [],
  });

  await emit('room:checkin', { stayId: 's5', guestId: 'g5', reservationId: 'dea', depositAmount: 0 });

  const roomCharges = memDb.folioTransaction.filter((t) => t.chargeCode === 'RM');
  assert.strictEqual(roomCharges.length, 2, 'one charge per reserved night');
  assert.ok(roomCharges.every((t) => t.amountCents === 280000n));
  assert.strictEqual(
    roomCharges.reduce((sum, t) => sum + t.amountCents, 0n),
    560000n
  );

  // Both nights, dated from the reservation's own check-in day forward.
  assert.ok(roomCharges.some((t) => t.reference === auditRefFor(TODAY, 's5')));
  assert.ok(roomCharges.some((t) => t.reference === auditRefFor(addDays(TODAY, 1), 's5')));

  const expectedTax = computeTax({ subtotalCents: 280000n, category: 'ROOM', rates: FIXED_RATES }).taxCents;
  assert.ok(roomCharges.every((t) => t.taxAmountCents === expectedTax));
  assert.ok(roomCharges.every((t) => Array.isArray(t.taxBreakdown) && t.taxBreakdown.length > 0));
});

test('a same-day night audit re-run would find every night already posted', async () => {
  reset();
  reservationsById.set('r2', {
    id: 'r2',
    nights: 3,
    checkIn: new Date().toISOString(),
    totalEstimateCents: 900000,
  });
  await emit('room:checkin', { stayId: 's6', guestId: 'g6', reservationId: 'r2' });

  // This is the SAME lookup audit.routes.js does before posting a room
  // charge for a stay on a given business day — for every night of the stay.
  for (let i = 0; i < 3; i += 1) {
    const ref = auditRefFor(addDays(TODAY, i), 's6');
    assert.ok(
      memDb.folioTransaction.some((t) => t.reference === ref),
      `expected night ${i} (${ref}) to already be posted`
    );
  }
});

test('a redelivered check-in event never double-posts any night', async () => {
  reset();
  reservationsById.set('r3', {
    id: 'r3',
    nights: 2,
    checkIn: new Date().toISOString(),
    totalEstimateCents: 300000,
  });
  await emit('room:checkin', { stayId: 's7', guestId: 'g7', reservationId: 'r3' });
  await emit('room:checkin', { stayId: 's7', guestId: 'g7', reservationId: 'r3' });

  assert.strictEqual(memDb.folioTransaction.filter((t) => t.chargeCode === 'RM').length, 2);
});

test('a check-in with no reservation (walk-in) posts no room charge', async () => {
  reset();
  await emit('room:checkin', { stayId: 's8', guestId: 'g8', walkIn: true });

  assert.strictEqual(memDb.folioTransaction.filter((t) => t.chargeCode === 'RM').length, 0);
});

// Reservations & Walk-Ins item 6: a walk-in's deposit posted (the folio
// PAYMENT above always ran), but the room itself never got charged, because
// this whole block used to be gated on `data.reservationId` and a walk-in
// never has one. stay.routes.js's POST /api/walk-in now puts the rate and
// night count directly on the check-in event instead, since there is no
// reservation to fetch them from.
test('a walk-in WITH a rate on the event posts room charges for every night', async () => {
  reset();
  await emit('room:checkin', {
    stayId: 's10',
    guestId: 'g10',
    walkIn: true,
    nightlyRateCents: 250000,
    nights: 2,
  });

  const roomCharges = memDb.folioTransaction.filter((t) => t.chargeCode === 'RM');
  assert.strictEqual(roomCharges.length, 2, 'one line per night, same as a reservation check-in');
  for (const tx of roomCharges) assert.strictEqual(Number(tx.amountCents), 250000);
});

test('a redelivered walk-in check-in event never double-posts the room charge', async () => {
  reset();
  const event = { stayId: 's11', guestId: 'g11', walkIn: true, nightlyRateCents: 180000, nights: 1 };
  await emit('room:checkin', event);
  await emit('room:checkin', event);

  assert.strictEqual(memDb.folioTransaction.filter((t) => t.chargeCode === 'RM').length, 1);
});

test('a reservation with no usable rate (zero total) posts no room charge', async () => {
  reset();
  reservationsById.set('r4', {
    id: 'r4',
    nights: 3,
    checkIn: new Date().toISOString(),
    totalEstimateCents: 0,
  });
  await emit('room:checkin', { stayId: 's9', guestId: 'g9', reservationId: 'r4' });

  assert.strictEqual(memDb.folioTransaction.filter((t) => t.chargeCode === 'RM').length, 0);
});

test('the full room total and reservation add-ons are both posted from the same check-in', async () => {
  reset();
  reservationsById.set('r5', {
    id: 'r5',
    nights: 2,
    checkIn: new Date().toISOString(),
    totalEstimateCents: 400000,
    addOns: [{ description: 'Honeymoon arrangements', totalCents: 330000 }],
  });
  await emit('room:checkin', { stayId: 's10', guestId: 'g10', reservationId: 'r5' });

  assert.strictEqual(memDb.folioTransaction.filter((t) => t.chargeCode === 'RM').length, 2);
  assert.ok(
    memDb.folioTransaction.some(
      (t) =>
        t.reference === 'ADDON-r5-0' &&
        t.description === 'Honeymoon arrangements' &&
        t.amountCents === 330000n
    )
  );
});
