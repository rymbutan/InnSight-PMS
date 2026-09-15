const { test } = require('node:test');
const assert = require('node:assert/strict');

// policy.js pulls in prisma at require time; stub it out so the pure parts can
// be tested without a database. Same technique as routes/authz.test.js.
require.cache[require.resolve('../lib/prisma')] = { exports: new Proxy({}, { get: () => () => {} }) };

const { MODES, DEFAULT_MODE, isMode, modeOf, cutoffFor } = require('./policy');

test('the shipped default keeps messages', () => {
  // A deploy must never delete history nobody asked it to delete. If this ever
  // needs to change, it is a data-loss decision and not a default tweak.
  assert.equal(DEFAULT_MODE, 'never');
  assert.equal(modeOf('never').ms, null);
});

test('every mode the admin UI can offer is one the server accepts', () => {
  for (const m of MODES) assert.ok(isMode(m.mode), `${m.mode} is listed but not accepted`);
});

test('an unknown or absent mode falls back to keeping messages', () => {
  // A hand-edited row, or a mode removed in a later version, must not be read as
  // "delete something" — the fallback is always the non-destructive one.
  for (const bad of ['', '2h', 'DROP TABLE', null, undefined]) {
    assert.equal(isMode(bad), false);
    assert.equal(modeOf(bad).mode, 'never');
  }
});

test('duration modes produce a cutoff that many milliseconds in the past', () => {
  const now = Date.UTC(2026, 8, 15, 12, 0, 0);
  const cases = [
    ['1h', 1],
    ['3h', 3],
    ['5h', 5],
    ['12h', 12],
    ['24h', 24],
    ['7d', 24 * 7],
  ];
  for (const [mode, hours] of cases) {
    const cutoff = cutoffFor(modeOf(mode), now);
    assert.equal(cutoff.getTime(), now - hours * 3600 * 1000, `${mode} cutoff is wrong`);
  }
});

test('the session-scoped and keep-forever modes have no age cutoff', () => {
  // 'logout' expires on an auth event, not on a clock — a cutoff here would
  // quietly add an age limit nobody configured.
  for (const mode of ['never', 'logout']) {
    assert.equal(cutoffFor(modeOf(mode)), null);
  }
});
