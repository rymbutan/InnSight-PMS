const test = require('node:test');
const assert = require('node:assert');

const { PAYMENT_METHODS, PAYMENT_METHOD_CODES, E_WALLET_METHODS, categoryOf, isEWallet } =
  require('./paymentMethods');

test('GCash and Maya are both classified E_WALLET', () => {
  assert.equal(categoryOf('GCASH'), 'E_WALLET');
  assert.equal(categoryOf('MAYA'), 'E_WALLET');
});

test('cash, card and bank transfer are not e-wallets', () => {
  assert.equal(categoryOf('CASH'), 'CASH');
  assert.equal(categoryOf('CARD'), 'CARD');
  assert.equal(categoryOf('BANK_TRANSFER'), 'BANK_TRANSFER');
  assert.equal(isEWallet('CASH'), false);
  assert.equal(isEWallet('CARD'), false);
});

test('the generic QR wallet is an e-wallet too — an unbranded stand-in for one', () => {
  assert.equal(categoryOf('QR_WALLET'), 'E_WALLET');
  assert.equal(isEWallet('QR_WALLET'), true);
});

test('the generic manual-entry E_WALLET method classifies as E_WALLET too', () => {
  assert.equal(categoryOf('E_WALLET'), 'E_WALLET');
  assert.equal(isEWallet('E_WALLET'), true);
});

test('lookup is case-insensitive, since callers copy strings from a JWT, a form, or JSON', () => {
  assert.equal(categoryOf('gcash'), 'E_WALLET');
  assert.equal(isEWallet('gcash'), true);
});

test('an unknown method has no category and is not an e-wallet', () => {
  assert.equal(categoryOf('BITCOIN'), null);
  assert.equal(categoryOf(''), null);
  assert.equal(categoryOf(undefined), null);
  assert.equal(isEWallet('BITCOIN'), false);
});

test('E_WALLET_METHODS lists exactly the methods PAYMENT_METHODS classifies as E_WALLET', () => {
  const derived = PAYMENT_METHOD_CODES.filter((m) => PAYMENT_METHODS[m].category === 'E_WALLET');
  assert.deepEqual(E_WALLET_METHODS.slice().sort(), derived.sort());
  assert.ok(E_WALLET_METHODS.includes('GCASH'));
  assert.ok(E_WALLET_METHODS.includes('MAYA'));
});

test('every method has a human label', () => {
  for (const code of PAYMENT_METHOD_CODES) {
    assert.equal(typeof PAYMENT_METHODS[code].label, 'string');
    assert.ok(PAYMENT_METHODS[code].label.length > 0);
  }
});
