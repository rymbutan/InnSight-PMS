const test = require('node:test');
const assert = require('node:assert');

const { folioListRow } = require('./folioList');

const CODES = { roomCodes: new Set(['RM']), facilityCodes: new Set(['POOL']) };

test('the row balance matches the classifier the bill is computed from', () => {
  const row = folioListRow(
    {
      id: 'f1',
      folioNumber: 'F-00011',
      status: 'OPEN',
      currency: 'PHP',
      stayId: 's1',
      guestId: 'g1',
      openedAt: new Date('2026-09-01T00:00:00.000Z'),
      transactions: [
        { type: 'CHARGE', chargeCode: 'RM', amountCents: 2535000n, taxAmountCents: 557700n },
        { type: 'PAYMENT', chargeCode: null, amountCents: 100000n, taxAmountCents: 0n },
      ],
    },
    CODES,
    'Jana Felismino'
  );
  assert.equal(row.folioNumber, 'F-00011');
  assert.equal(row.guestName, 'Jana Felismino');
  // 25,350.00 + 5,577.00 tax - 1,000.00 paid = 29,927.00
  assert.equal(row.balanceCents, '2992700');
});

test('balanceCents is a string, because JSON cannot carry BigInt', () => {
  const row = folioListRow(
    { id: 'f1', folioNumber: 'F-1', status: 'OPEN', currency: 'PHP', transactions: [] },
    CODES,
    null
  );
  assert.equal(typeof row.balanceCents, 'string');
  assert.equal(row.balanceCents, '0');
});

test('an unresolved guest name degrades to null rather than failing the row', () => {
  // The list must still render when the guest service is unreachable -- a folio
  // list that 500s because a NAME could not be fetched is a worse regression
  // than the missing search it replaces.
  const row = folioListRow(
    { id: 'f1', folioNumber: 'F-1', status: 'OPEN', currency: 'PHP', transactions: [] },
    CODES,
    undefined
  );
  assert.equal(row.guestName, null);
  assert.equal(row.folioNumber, 'F-1');
});

test('the transactions array is not leaked into the row', () => {
  const row = folioListRow(
    {
      id: 'f1',
      folioNumber: 'F-1',
      status: 'OPEN',
      currency: 'PHP',
      transactions: [{ type: 'CHARGE', chargeCode: 'RM', amountCents: 100n, taxAmountCents: 0n }],
    },
    CODES,
    null
  );
  assert.equal(row.transactions, undefined, 'a list row must not carry a full ledger');
});

// ── payerName / chargeType (bill splitting) ─────────────────────────────────

test("a folio's own payerName wins over the stay's overall guest name", () => {
  // The exact bug this locks in: a bill split into "Jeffrey Par" and "Andrei
  // Sumilang" used to show "Jeffrey Par" on BOTH folios in this list, because
  // Folio.guestId links the STAY's guest, not who this specific folio bills.
  const row = folioListRow(
    {
      id: 'f2',
      folioNumber: 'F-2',
      status: 'OPEN',
      currency: 'PHP',
      payerName: 'Andrei Sumilang',
      transactions: [],
    },
    CODES,
    'Jeffrey Par'
  );
  assert.equal(row.guestName, 'Andrei Sumilang');
});

test('a folio with no distinct payer still falls back to the stay guest name', () => {
  const row = folioListRow(
    { id: 'f1', folioNumber: 'F-1', status: 'OPEN', currency: 'PHP', payerName: null, transactions: [] },
    CODES,
    'Jeffrey Par'
  );
  assert.equal(row.guestName, 'Jeffrey Par');
});

test('the raw payerName rides along separately from the display-preferred guestName', () => {
  // Folios.jsx's stayGuestName fallback needs to tell "this row's name IS a
  // distinct split payer" apart from "this row's name IS the stay's guest" —
  // guestName alone (payerName-preferred) cannot make that distinction.
  const split = folioListRow(
    {
      id: 'f2',
      folioNumber: 'F-2',
      status: 'OPEN',
      currency: 'PHP',
      payerName: 'Andrei Sumilang',
      transactions: [],
    },
    CODES,
    'Jeffrey Par'
  );
  assert.equal(split.payerName, 'Andrei Sumilang');

  const solo = folioListRow(
    { id: 'f1', folioNumber: 'F-1', status: 'OPEN', currency: 'PHP', payerName: null, transactions: [] },
    CODES,
    'Jeffrey Par'
  );
  assert.equal(solo.payerName, null);
});

test('chargeType defaults to SOLO when the route does not say this stay was split', () => {
  const row = folioListRow(
    { id: 'f1', folioNumber: 'F-1', status: 'OPEN', currency: 'PHP', transactions: [] },
    CODES,
    null
  );
  assert.equal(row.chargeType, 'SOLO');
});

test('chargeType is SPLIT when the route says another folio shares this stay', () => {
  const row = folioListRow(
    { id: 'f1', folioNumber: 'F-1', status: 'OPEN', currency: 'PHP', stayId: 's1', transactions: [] },
    CODES,
    null,
    { isSplit: true }
  );
  assert.equal(row.chargeType, 'SPLIT');
});
