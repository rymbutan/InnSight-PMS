const test = require('node:test');
const assert = require('node:assert');

const {
  parseTaxRates,
  validateTaxRates,
  parseHotel,
  validateHotel,
  TAX_RATE_KEYS,
} = require('./settings');

test('missing rows fall back to the shipped defaults', () => {
  const rates = parseTaxRates([]);
  assert.deepEqual(rates, { vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 });
});

test('stored rows override the defaults', () => {
  const rates = parseTaxRates([
    { key: 'tax_vat_percent', value: '10' },
    { key: 'tax_local_percent', value: '1.85' },
  ]);
  assert.equal(rates.vat, 10);
  assert.equal(rates.localTax, 1.85);
  assert.equal(rates.serviceCharge, 10, 'an unset key keeps its default');
});

test('a corrupt stored value falls back rather than yielding NaN', () => {
  // A NaN rate would silently produce NaN tax on a guest's bill.
  const rates = parseTaxRates([{ key: 'tax_vat_percent', value: 'twelve' }]);
  assert.equal(rates.vat, 12);
});

test('every component has a settings key', () => {
  assert.deepEqual(Object.keys(TAX_RATE_KEYS).sort(), [
    'localTax', 'realPropertyTax', 'serviceCharge', 'vat',
  ]);
});

test('validation accepts a full, in-range payload', () => {
  const r = validateTaxRates({ vat: 12, serviceCharge: 10, localTax: 1.85, realPropertyTax: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.rates.localTax, 1.85);
});

test('validation accepts a partial payload and keeps the rest at their defaults', () => {
  const r = validateTaxRates({ vat: 8 });
  assert.equal(r.ok, true);
  assert.equal(r.rates.vat, 8);
  assert.equal(r.rates.serviceCharge, 10);
});

test('validation rejects out-of-range and non-numeric rates', () => {
  for (const bad of [{ vat: -1 }, { vat: 101 }, { vat: 'abc' }, { serviceCharge: NaN }, { localTax: Infinity }]) {
    assert.equal(validateTaxRates(bad).ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('validation rejects an unknown key rather than silently dropping it', () => {
  const r = validateTaxRates({ vat: 12, wineTax: 5 });
  assert.equal(r.ok, false);
  assert.match(r.error, /wineTax/);
});

test('hotel identity defaults to InnSight, never to the reference property', () => {
  const hotel = parseHotel([]);
  assert.equal(hotel.name, 'InnSight PMS');
  // The reference invoice belongs to a real business. Shipping its details as
  // defaults would make every printed folio impersonate it.
  const joined = JSON.stringify(hotel).toLowerCase();
  assert.ok(!joined.includes('aureliscita'), 'must not ship a real property as a default');
});

test('stored hotel rows override the defaults', () => {
  const hotel = parseHotel([
    { key: 'hotel_name', value: 'Test Grand Hotel' },
    { key: 'hotel_email', value: 'desk@example.test' },
  ]);
  assert.equal(hotel.name, 'Test Grand Hotel');
  assert.equal(hotel.email, 'desk@example.test');
  assert.equal(typeof hotel.address, 'string', 'unset fields are still present as strings');
});

// ── Service times ───────────────────────────────────────────────────────────
// The property's check-in and check-out times. These stopped being cosmetic
// when the reservation service began stamping them onto checkIn/checkOut: the
// no-double-booking constraint compares tsrange(checkIn, checkOut), so these
// two values decide whether a same-day turnover is a conflict or a clean
// handover. A malformed one must never reach that comparison.
test('service times default to a 14:00 check-in and a 12:00 check-out', () => {
  const hotel = parseHotel([]);
  assert.strictEqual(hotel.checkInTime, '14:00');
  assert.strictEqual(hotel.checkOutTime, '12:00');
});

test('stored service times are read back', () => {
  const hotel = parseHotel([
    { key: 'hotel_checkin_time', value: '15:30' },
    { key: 'hotel_checkout_time', value: '11:00' },
  ]);
  assert.strictEqual(hotel.checkInTime, '15:30');
  assert.strictEqual(hotel.checkOutTime, '11:00');
});

// Format is checked as a PAIR, because the ordering rule below means a
// format-valid time is not automatically an acceptable one: a 09:05 check-in
// cannot sit alongside the default 12:00 check-out.
test('well-formed 24-hour times are accepted', () => {
  for (const [inT, outT] of [
    ['09:05', '08:00'],
    ['14:00', '12:00'],
    ['23:59', '00:00'],
  ]) {
    const out = validateHotel({ checkInTime: inT, checkOutTime: outT });
    assert.strictEqual(out.ok, true, `${inT}/${outT} should be accepted: ${out.error || ''}`);
    assert.strictEqual(out.hotel.checkInTime, inT);
    assert.strictEqual(out.hotel.checkOutTime, outT);
  }
});

test('a malformed time is refused rather than stored', () => {
  for (const t of ['2pm', '14', '14:60', '24:00', '9:5', '', 'noon', '14:00:00']) {
    const out = validateHotel({ checkOutTime: t });
    assert.strictEqual(out.ok, false, `${JSON.stringify(t)} should be refused`);
    assert.match(out.error, /checkOutTime/);
  }
});

test('check-out at or after check-in is refused — it would invert every stay', () => {
  // 14:00 in, 14:00 out would make a one-night booking zero-length, and the
  // exclusion constraint would then see every back-to-back pair as overlapping.
  const same = validateHotel({ checkInTime: '14:00', checkOutTime: '14:00' });
  assert.strictEqual(same.ok, false);
  const inverted = validateHotel({ checkInTime: '10:00', checkOutTime: '12:00' });
  assert.strictEqual(inverted.ok, false, 'check-out must precede check-in on the clock');
});

test('the normal hotel shape — out in the morning, in the afternoon — is accepted', () => {
  const out = validateHotel({ checkInTime: '14:00', checkOutTime: '12:00' });
  assert.strictEqual(out.ok, true);
});
