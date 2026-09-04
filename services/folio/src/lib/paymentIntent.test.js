const test = require('node:test');
const assert = require('node:assert');
const { newToken, intentState, INTENT_TTL_MS } = require('./paymentIntent');

test('tokens are unguessable and url-safe', () => {
  const a = newToken();
  const b = newToken();
  assert.notEqual(a, b);
  // The confirm endpoint is unauthenticated — this token is the only thing between
  // a stranger and a posted payment, so length is a security property.
  assert.ok(a.length >= 32, `token was only ${a.length} chars`);
  assert.match(a, /^[A-Za-z0-9_-]+$/, 'must survive a URL and a QR without escaping');
});

test('a live pending intent is payable', () => {
  const future = new Date(Date.now() + 60_000);
  assert.equal(intentState({ status: 'PENDING', expiresAt: future }), 'PENDING');
});

test('a pending intent past its expiry reads as expired', () => {
  // Expiry is derived, never stored: a row written PENDING would otherwise stay
  // payable forever unless something swept it.
  const past = new Date(Date.now() - 1000);
  assert.equal(intentState({ status: 'PENDING', expiresAt: past }), 'EXPIRED');
});

test('a confirmed intent stays confirmed and cannot be replayed', () => {
  const past = new Date(Date.now() - 1000);
  assert.equal(intentState({ status: 'CONFIRMED', expiresAt: past }), 'CONFIRMED');
});

test('a cancelled intent stays cancelled even while unexpired', () => {
  const future = new Date(Date.now() + 60_000);
  assert.equal(intentState({ status: 'CANCELLED', expiresAt: future }), 'CANCELLED');
});

test('expiry is evaluated against the supplied clock', () => {
  const at = new Date('2026-09-04T10:00:00Z');
  assert.equal(intentState({ status: 'PENDING', expiresAt: new Date('2026-09-04T10:00:01Z') }, at), 'PENDING');
  assert.equal(intentState({ status: 'PENDING', expiresAt: new Date('2026-09-04T09:59:59Z') }, at), 'EXPIRED');
});

test('an intent expiring exactly now is expired, not payable', () => {
  const at = new Date('2026-09-04T10:00:00Z');
  assert.equal(intentState({ status: 'PENDING', expiresAt: at }, at), 'EXPIRED');
});

test('the window is long enough to find your phone and short enough to matter', () => {
  assert.ok(INTENT_TTL_MS >= 5 * 60_000 && INTENT_TTL_MS <= 30 * 60_000);
});
