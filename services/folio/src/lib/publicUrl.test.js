const test = require('node:test');
const assert = require('node:assert');
const { makePublicUrl } = require('./publicUrl');

test('joins without doubling or dropping slashes', () => {
  assert.equal(makePublicUrl('http://localhost:8080')('/portal/R-1'), 'http://localhost:8080/portal/R-1');
  assert.equal(makePublicUrl('http://localhost:8080/')('/portal/R-1'), 'http://localhost:8080/portal/R-1');
  assert.equal(makePublicUrl('https://innsight.example')('portal/R-1'), 'https://innsight.example/portal/R-1');
  assert.equal(makePublicUrl('https://innsight.example///')('//portal/R-1'), 'https://innsight.example/portal/R-1');
});

test('falls back to localhost when unset', () => {
  assert.equal(makePublicUrl(undefined).base, 'http://localhost:8080');
  assert.equal(makePublicUrl('').base, 'http://localhost:8080');
});

test('a QR pointing at localhost is flagged as unscannable', () => {
  // A phone resolving "localhost" reaches itself, so a code encoding it is dead on
  // arrival. Callers use this to choose between a scan prompt and an on-screen
  // fallback, which is what lets an offline demo degrade honestly.
  assert.equal(makePublicUrl('http://localhost:8080').isScannableByPhone, false);
  assert.equal(makePublicUrl('http://127.0.0.1:8080').isScannableByPhone, false);
  assert.equal(makePublicUrl('http://[::1]:8080').isScannableByPhone, false);
});

test('a LAN address or a public host is scannable', () => {
  assert.equal(makePublicUrl('http://192.168.1.20:8080').isScannableByPhone, true);
  assert.equal(makePublicUrl('https://innsight.slsu.edu.ph').isScannableByPhone, true);
});

test('a hostname merely containing "localhost" is still scannable', () => {
  // Guards a naive substring check: this is a real, resolvable host.
  assert.equal(makePublicUrl('https://localhost-demo.example.com').isScannableByPhone, true);
});
