const test = require('node:test');
const assert = require('node:assert');

const { folioPrintModel } = require('./folioPrintModel');
const { classifyTransactions } = require('./folioSummary');

const ROOM_CODES = { roomCodes: new Set(['RM']), facilityCodes: new Set(['POOL']) };

function build(transactions, extra = {}) {
  // The route tags each charge with whether it is room revenue; the model relies
  // on that flag rather than re-deriving the classification.
  const tagged = transactions.map((t) => ({ ...t, __isRoom: ROOM_CODES.roomCodes.has(t.chargeCode) }));
  const summary = classifyTransactions(tagged, ROOM_CODES);
  return folioPrintModel({
    folio: { folioNumber: '11', currency: 'PHP' },
    transactions: tagged,
    summary,
    guest: { nationality: 'Filipino' },
    stay: { actualCheckInAt: '2025-05-21T03:58:19.000Z' },
    reservation: {
      checkIn: '2025-05-21T00:00:00.000Z', checkOut: '2025-05-25T00:00:00.000Z',
      adults: 2, children: 3, nights: 3, confirmationNumber: 'CN-11',
    },
    hotel: { name: 'Test Hotel', address: '', phone: '', fax: '', email: '', url: '' },
    ...extra,
  });
}

function sectionNamed(model, title) {
  const s = model.sections.find((x) => x.title === title);
  assert.ok(s, `expected a "${title}" section`);
  return s;
}

// The reference invoice, reproduced. 3 nights at 8,450.00 = 25,350.00 room
// charge, VAT 3,042.00 and service charge 2,535.00.
const REFERENCE_TX = [
  {
    type: 'CHARGE', chargeCode: 'RM', description: 'Room charge',
    amountCents: 2535000n, taxAmountCents: 557700n,
    taxBreakdown: [
      { key: 'vat', label: 'VAT', rate: 12, amountCents: '304200' },
      { key: 'serviceCharge', label: 'Service Charge', rate: 10, amountCents: '253500' },
      { key: 'localTax', label: 'Local Tax', rate: 0, amountCents: '0' },
      { key: 'realPropertyTax', label: 'Real Property Tax', rate: 0, amountCents: '0' },
    ],
  },
];

test('the header block carries the guest and stay facts the reference shows', () => {
  const m = build(REFERENCE_TX);
  assert.equal(m.meta.folioNumber, '11');
  assert.equal(m.meta.nationality, 'Filipino');
  assert.equal(m.meta.pax, 5, 'adults + children');
  assert.equal(m.meta.adults, 2);
  assert.equal(m.meta.children, 3);
  assert.equal(m.meta.grCardNo, 'CN-11', 'the confirmation number stands in for the G.R. card');
  assert.equal(m.meta.tariffCents, 845000n, '25,350.00 over 3 nights');
});

test('room tax renders all four components in reference order', () => {
  const m = build(REFERENCE_TX);
  const tax = sectionNamed(m, 'Add : Room Tax');
  assert.deepEqual(
    tax.rows.map((r) => r.label),
    ['VAT', 'Service Charge', 'Local Tax', 'Real Property Tax']
  );
  assert.equal(tax.rows[0].amountCents, 304200n);
  assert.equal(tax.rows[1].amountCents, 253500n);
  assert.equal(tax.subtotalCents, 557700n);
});

// The compatibility rule: a folio posted before the breakdown column existed
// must still print, with its whole tax on the VAT line and the SAME total.
test('a null breakdown attributes the whole tax to VAT', () => {
  const m = build([
    { type: 'CHARGE', chargeCode: 'RM', description: 'Room charge',
      amountCents: 2535000n, taxAmountCents: 557700n, taxBreakdown: null },
  ]);
  const tax = sectionNamed(m, 'Add : Room Tax');
  assert.equal(tax.rows[0].label, 'VAT');
  assert.equal(tax.rows[0].amountCents, 557700n);
  assert.equal(tax.rows[1].amountCents, 0n, 'nothing is invented for the other components');
  assert.equal(tax.subtotalCents, 557700n, 'the total is unchanged');
});

// The reference prints Room Charges gross with Less Discount beneath. The
// classifier already nets a negative room charge in, so printing its figure as
// "Room Charges" AND the discount again would deduct it twice.
test('a room discount shows gross, the deduction, and a correct net subtotal', () => {
  const m = build([
    { type: 'CHARGE', chargeCode: 'RM', description: 'Room charge', amountCents: 2535000n, taxAmountCents: 0n },
    { type: 'CHARGE', chargeCode: 'RM', description: 'Corporate rate', amountCents: -35000n, taxAmountCents: 0n },
  ]);
  const room = sectionNamed(m, 'Room Charges');
  assert.equal(room.rows[0].amountCents, 2535000n, 'gross, before the discount');
  assert.equal(room.rows[1].amountCents, 35000n, 'the deduction, shown positive');
  assert.equal(room.subtotalCents, 2500000n, 'net — and it must not be deducted twice');
  assert.equal(m.totals.balanceCents, 2500000n);
});

test('with no discount, gross equals the subtotal and the discount row is zero', () => {
  const m = build(REFERENCE_TX);
  const room = sectionNamed(m, 'Room Charges');
  assert.equal(room.rows[0].amountCents, 2535000n);
  assert.equal(room.rows[1].amountCents, 0n);
  assert.equal(room.subtotalCents, 2535000n);
});

test('the room tax subtotal always equals the summary tax on room charges', () => {
  const m = build(REFERENCE_TX);
  const tax = sectionNamed(m, 'Add : Room Tax');
  const onCharges = sectionNamed(m, 'Add : Tax On Charges');
  assert.equal(tax.subtotalCents + onCharges.subtotalCents, 557700n);
});

test('non-room tax lands in Tax On Charges, not Room Tax', () => {
  const m = build([
    { type: 'CHARGE', chargeCode: 'RM', description: 'Room', amountCents: 100000n, taxAmountCents: 12000n,
      taxBreakdown: [{ key: 'vat', label: 'VAT', rate: 12, amountCents: '12000' }] },
    { type: 'CHARGE', chargeCode: 'MB', description: 'Minibar', amountCents: 50000n, taxAmountCents: 6000n,
      taxBreakdown: [{ key: 'vat', label: 'VAT', rate: 12, amountCents: '6000' }] },
  ]);
  assert.equal(sectionNamed(m, 'Add : Room Tax').subtotalCents, 12000n);
  assert.equal(sectionNamed(m, 'Add : Tax On Charges').subtotalCents, 6000n);
  assert.equal(sectionNamed(m, 'Add : Extra Charges').subtotalCents, 50000n);
});

test('transfers split into the From and To sections by sign', () => {
  const m = build([
    { type: 'TRANSFER', chargeCode: 'RM', description: 'From folio 12', amountCents: 30000n, taxAmountCents: 0n },
    { type: 'TRANSFER', chargeCode: 'RM', description: 'To folio 13', amountCents: -20000n, taxAmountCents: 0n },
  ]);
  assert.equal(sectionNamed(m, 'Add : Transferred From Folio').subtotalCents, 30000n);
  assert.equal(sectionNamed(m, 'Less : Transferred To Folio').subtotalCents, 20000n, 'shown as a positive deduction');
});

test('payments appear under Less : Amount Paid, net of refunds', () => {
  const m = build([
    { type: 'CHARGE', chargeCode: 'RM', description: 'Room', amountCents: 100000n, taxAmountCents: 0n },
    { type: 'PAYMENT', chargeCode: null, description: 'Cash', amountCents: 60000n, taxAmountCents: 0n },
    { type: 'REFUND', chargeCode: null, description: 'Refund', amountCents: 10000n, taxAmountCents: 0n },
  ]);
  assert.equal(sectionNamed(m, 'Less : Amount Paid').subtotalCents, 50000n);
  assert.equal(m.totals.totalPaymentCents, 50000n);
  assert.equal(m.totals.balanceCents, 50000n);
});

// The whole point of the document: the right-hand rail must agree with the
// classifier every other part of the system bills from.
test('totals match classifyTransactions exactly', () => {
  const tx = [
    { type: 'CHARGE', chargeCode: 'RM', description: 'Room', amountCents: 2535000n, taxAmountCents: 557700n, taxBreakdown: null },
    { type: 'CHARGE', chargeCode: 'MB', description: 'Minibar', amountCents: 50000n, taxAmountCents: 6000n, taxBreakdown: null },
    { type: 'PAYMENT', chargeCode: null, description: 'Cash', amountCents: 100000n, taxAmountCents: 0n },
    { type: 'ADJUSTMENT', chargeCode: null, description: 'Goodwill', amountCents: -5000n, taxAmountCents: 0n },
  ];
  const summary = classifyTransactions(tx, ROOM_CODES);
  const m = build(tx);
  assert.equal(m.totals.totalChargesCents, summary.totalChargesCents);
  assert.equal(m.totals.balanceCents, summary.balanceCents);
});

test('every section is present even when empty, so the layout never collapses', () => {
  const m = build([]);
  for (const title of [
    'Room Charges', 'Add : Room Tax', 'Add : Extra Charges', 'Add : Tax On Charges',
    'Add : Transferred From Folio', 'Less : Flat Discount', 'Less : Amount Paid',
    'Less : Transferred To Folio', 'Adjustment',
  ]) {
    sectionNamed(m, title);
  }
  assert.equal(m.totals.balanceCents, 0n);
});

test('the balance is rendered in words', () => {
  const m = build(REFERENCE_TX);
  assert.match(m.footer.amountInWords.toUpperCase(), /THIRTY/);
});

test('the guest nationality stands in for the address line', () => {
  const m = build(REFERENCE_TX);
  assert.equal(m.footer.address, 'Filipino');
  assert.equal(m.footer.currency, 'PHP');
});

test('missing guest, stay and reservation degrade to dashes, never throw', () => {
  const m = build(REFERENCE_TX, { guest: null, stay: null, reservation: null });
  assert.equal(m.meta.nationality, '—');
  assert.equal(m.meta.grCardNo, '—');
  assert.equal(m.meta.pax, '—');
  // Staff need folios to print during an audit even when an upstream is down.
  assert.equal(m.totals.balanceCents, 3092700n);
});
