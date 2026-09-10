const test = require('node:test');
const assert = require('node:assert');

const { missingDepositField } = require('./missingDepositField');

test('CASH and E_WALLET require nothing extra', () => {
  assert.equal(missingDepositField('CASH', {}), null);
  assert.equal(missingDepositField('E_WALLET', {}), null);
});

test('CARD requires cardMasked and cardholderName', () => {
  assert.match(missingDepositField('CARD', {}), /last 4 digits/i);
  assert.match(missingDepositField('CARD', { cardMasked: 'VISA •••• 4242' }), /cardholder name/i);
  assert.equal(
    missingDepositField('CARD', { cardMasked: 'VISA •••• 4242', cardholderName: 'Juan Dela Cruz' }),
    null
  );
});

test('BANK_TRANSFER requires bank, network, sender, and a reference', () => {
  assert.match(missingDepositField('BANK_TRANSFER', {}), /bank name/i);
  assert.match(missingDepositField('BANK_TRANSFER', { bankName: 'BDO' }), /transfer network/i);
  assert.match(
    missingDepositField('BANK_TRANSFER', { bankName: 'BDO', transferNetwork: 'InstaPay' }),
    /sender/i
  );
  assert.match(
    missingDepositField('BANK_TRANSFER', {
      bankName: 'BDO',
      transferNetwork: 'InstaPay',
      senderName: 'Juan Dela Cruz',
    }),
    /reference/i
  );
  assert.equal(
    missingDepositField('BANK_TRANSFER', {
      bankName: 'BDO',
      transferNetwork: 'InstaPay',
      senderName: 'Juan Dela Cruz',
      reference: 'REF123',
    }),
    null
  );
  // gatewayRef satisfies the same requirement as reference.
  assert.equal(
    missingDepositField('BANK_TRANSFER', {
      bankName: 'BDO',
      transferNetwork: 'InstaPay',
      senderName: 'Juan Dela Cruz',
      gatewayRef: 'REF123',
    }),
    null
  );
});
