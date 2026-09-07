const test = require('node:test');
const assert = require('node:assert');

const { regCardModel, REG_CARD_TITLE } = require('./regCardModel');

const stay = {
  id: 's1',
  reservationId: 'r1',
  guestId: 'g1',
  guestName: 'Dela Cruz, Maria',
  assignedRoomId: '109',
  status: 'PRE_ARRIVAL',
  expectedCheckIn: new Date('2026-08-30T06:00:00.000Z'),
  expectedCheckOut: new Date('2026-09-02T04:00:00.000Z'),
  keyCardsIssued: 2,
};
const reservation = {
  confirmationNumber: 'R-7D3E023A0524',
  guestEmail: 'maria@example.com',
  guestPhone: '+63 917 555 0101',
  adults: 2,
  children: 0,
  nights: 3,
  roomTypeCode: 'DLX',
  totalEstimateCents: 1260000,
  expectedArrivalTime: '14:30',
  specialRequests: 'Honeymoon trip',
};
const guest = { firstName: 'Maria', lastName: 'Dela Cruz', nationality: 'Philippines' };
const hotel = {
  name: 'InnSight Training Hotel',
  address: 'Sorsogon City, Philippines',
  phone: '+63 56 000 0000',
  email: 'desk@innsight.test',
  url: 'innsight.test',
};
const roomTypes = [
  { code: 'STD', name: 'Standard', baseRate: 280000 },
  { code: 'DLX', name: 'Deluxe', baseRate: 420000 },
  { code: 'STE', name: 'Suite', baseRate: 750000 },
];

const build = (over = {}) =>
  regCardModel({ stay, reservation, guest, hotel, roomTypes, ...over });

test('the card is titled InnSight PMS Registration Card', () => {
  assert.strictEqual(build().title, 'InnSight PMS Registration Card');
  assert.strictEqual(REG_CARD_TITLE, 'InnSight PMS Registration Card');
});

test('guest fields are filled from the system, not left blank', () => {
  const byLabel = Object.fromEntries(build().fields.map((f) => [f.label, f.value]));
  assert.strictEqual(byLabel.Name, 'Maria Dela Cruz');
  assert.strictEqual(byLabel.Country, 'Philippines');
  assert.strictEqual(byLabel.Phone, '+63 917 555 0101');
  assert.strictEqual(byLabel.Email, 'maria@example.com');
});

// Address has no backing column anywhere in the system (Guest has none, and the
// New Reservation form's address inputs are discarded on save), so the row is
// printed for handwriting rather than pretending to hold a value.
test('address is an empty line because nothing in the system stores one', () => {
  const addr = build().fields.find((f) => f.label === 'Address');
  assert.strictEqual(addr.value, '');
  assert.strictEqual(addr.writeIn, true);
});

test('name falls back to the stay guestName when there is no guest record', () => {
  const byLabel = Object.fromEntries(
    build({ guest: null }).fields.map((f) => [f.label, f.value])
  );
  assert.strictEqual(byLabel.Name, 'Dela Cruz, Maria');
});

test('duration ticks the box matching the number of nights', () => {
  const d = build().duration;
  assert.deepStrictEqual(
    d.options.map((o) => [o.nights, o.checked]),
    [
      [1, false],
      [2, false],
      [3, true],
    ]
  );
  assert.strictEqual(d.otherNights, null);
});

test('a stay longer than three nights fills the write-in box instead', () => {
  const d = build({ reservation: { ...reservation, nights: 5 } }).duration;
  assert.ok(d.options.every((o) => !o.checked));
  assert.strictEqual(d.otherNights, 5);
});

test('nights are derived from the stay dates when the reservation has none', () => {
  const d = build({ reservation: { ...reservation, nights: null } }).duration;
  assert.strictEqual(d.options.find((o) => o.nights === 3).checked, true);
});

test('room rows carry real rates and tick the booked category', () => {
  const rows = build().rooms.rows;
  assert.deepStrictEqual(
    rows.map((r) => [r.name, r.rate, r.checked]),
    [
      ['Standard', 'PHP 2,800.00', false],
      ['Deluxe', 'PHP 4,200.00', true],
      ['Suite', 'PHP 7,500.00', false],
    ]
  );
});

test('the schedule grid is filled from the stay dates and arrival time', () => {
  const rows = build().schedule.rows;
  const arrival = rows.find((r) => r.label === 'Arrival');
  const departure = rows.find((r) => r.label === 'Departure');
  assert.strictEqual(arrival.date, '08/30/2026');
  assert.strictEqual(arrival.time, '14:30');
  assert.strictEqual(departure.date, '09/02/2026');
  // No flight number is captured anywhere in the system.
  assert.strictEqual(arrival.flight, '');
});

test('total cost comes from the reservation estimate', () => {
  assert.strictEqual(build().totals.totalCost, 'PHP 12,600.00');
});

// pdfkit's built-in Helvetica is WinAnsi-encoded and has no glyph for U+20B1,
// so a '₱' prefix printed on the card as '±'. The folio PDF already prints the
// ISO code for this reason (`${model.currency} ${amount}`); the card matches it
// rather than shipping a font file to render one character.
test('amounts use the PHP currency code, never the peso glyph', () => {
  const printed = [...build().rooms.rows.map((r) => r.rate), build().totals.totalCost];
  for (const v of printed) {
    assert.ok(!v.includes('\u20B1'), `${v} still uses the peso glyph`);
    assert.match(v, /^PHP /);
  }
});

test('venue lines omit blanks so an unconfigured hotel prints no empty rows', () => {
  const lines = build({ hotel: { name: 'InnSight PMS', address: '', phone: '', email: '', url: '' } })
    .venue.lines;
  assert.deepStrictEqual(lines, ['InnSight PMS']);
});

// The card is a guest-facing document. A missing upstream must degrade it, never
// fail it — the desk still needs paper to check the guest in with.
test('it builds with only a stay and nothing else', () => {
  const m = regCardModel({ stay });
  assert.strictEqual(m.title, 'InnSight PMS Registration Card');
  assert.strictEqual(m.rooms.rows.length, 0);
  assert.strictEqual(m.totals.totalCost, '');
  assert.ok(m.fields.length > 0);
});
