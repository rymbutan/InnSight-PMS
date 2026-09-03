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
