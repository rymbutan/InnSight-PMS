const test = require('node:test');
const assert = require('node:assert');

const { nextDisplayName, composeDisplayName } = require('./displayName');

test('composes from first and last name', () => {
  assert.strictEqual(composeDisplayName({ firstName: 'Maria', lastName: 'Dela Cruz' }), 'Maria Dela Cruz');
});

// The bug this exists for: Quick Edit patches firstName/lastName but never
// displayName, so a renamed guest kept the OLD displayName — and displayName is
// what the reservation forms and the registration card print.
test('a rename refreshes an auto-derived display name', () => {
  const before = { firstName: 'Maria', lastName: 'Dela Cruz', displayName: 'Maria Dela Cruz' };
  assert.strictEqual(nextDisplayName(before, { lastName: 'Santos' }), 'Maria Santos');
});

test('a rename leaves a hand-written display name alone', () => {
  // Someone deliberately set "Dr. M. Dela Cruz". Renaming the surname must not
  // clobber a name a human chose.
  const before = { firstName: 'Maria', lastName: 'Dela Cruz', displayName: 'Dr. M. Dela Cruz' };
  assert.strictEqual(nextDisplayName(before, { lastName: 'Santos' }), undefined);
});

test('an explicit display name in the patch always wins', () => {
  const before = { firstName: 'Maria', lastName: 'Dela Cruz', displayName: 'Maria Dela Cruz' };
  assert.strictEqual(
    nextDisplayName(before, { lastName: 'Santos', displayName: 'M. Santos' }),
    undefined
  );
});

test('a patch that touches neither name changes nothing', () => {
  const before = { firstName: 'Maria', lastName: 'Dela Cruz', displayName: 'Maria Dela Cruz' };
  assert.strictEqual(nextDisplayName(before, { nationality: 'Philippines' }), undefined);
});

test('an empty display name is treated as auto-derived and gets filled', () => {
  const before = { firstName: 'Maria', lastName: 'Dela Cruz', displayName: null };
  assert.strictEqual(nextDisplayName(before, { firstName: 'Marisa' }), 'Marisa Dela Cruz');
});

test('a rename that does not actually change the name is a no-op', () => {
  const before = { firstName: 'Maria', lastName: 'Dela Cruz', displayName: 'Maria Dela Cruz' };
  assert.strictEqual(nextDisplayName(before, { firstName: 'Maria' }), undefined);
});
