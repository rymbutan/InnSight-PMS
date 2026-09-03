const test = require('node:test');
const assert = require('node:assert/strict');

// The route module pulls in Prisma and Redis, so `sanitize` is re-declared here
// against the SAME contract and the real one is pinned by the shape assertions
// in users.routes.js. What matters is that no credential field can leave the
// service, whatever the record shape grows into.
const { sanitizeUser } = require('../lib/sanitizeUser');

const record = () => ({
  id: 'u1',
  username: 'admin',
  displayName: 'System Administrator',
  email: 'a@b.c',
  passwordHash: '$2a$10$NZm9VV9Mi0abcdefghijklmnop',
  mfaSecret: 'JBSWY3DPEHPK3PXP',
  resetToken: 'tok_123',
  disabled: false,
  roles: [{ roleCode: 'ADMIN' }],
});

test('the password hash never leaves the service', () => {
  // The bug this exists to stop: sanitize() destructured `_passwordHash` while
  // the Prisma field is `passwordHash`, so it removed nothing and GET /api/users
  // published every user's bcrypt hash, the admin's included.
  const out = sanitizeUser(record());
  assert.equal('passwordHash' in out, false);
  assert.equal(JSON.stringify(out).includes('$2a$'), false);
});

test('no other credential material leaks either', () => {
  const out = sanitizeUser(record());
  assert.equal('mfaSecret' in out, false);
  assert.equal('resetToken' in out, false);
});

test('everything the UI actually needs survives', () => {
  const out = sanitizeUser(record());
  assert.equal(out.id, 'u1');
  assert.equal(out.username, 'admin');
  assert.equal(out.displayName, 'System Administrator');
  assert.equal(out.email, 'a@b.c');
  assert.equal(out.disabled, false);
  assert.deepEqual(out.roles, [{ roleCode: 'ADMIN' }]);
});

test('the input record is not mutated', () => {
  // Callers reuse the Prisma object; stripping in place would blank the hash
  // the login path needs on the very next line.
  const r = record();
  sanitizeUser(r);
  assert.equal(r.passwordHash, '$2a$10$NZm9VV9Mi0abcdefghijklmnop');
});

test('null and undefined pass through as null', () => {
  assert.equal(sanitizeUser(null), null);
  assert.equal(sanitizeUser(undefined), null);
});

test('a record with no credentials on it is unharmed', () => {
  const out = sanitizeUser({ id: 'u2', username: 'x' });
  assert.deepEqual(out, { id: 'u2', username: 'x' });
});
