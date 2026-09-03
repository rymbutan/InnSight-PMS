const { test } = require('node:test');
const assert = require('node:assert/strict');

// The route module pulls in express + prisma + the auth middleware, none of which
// we need in order to exercise the pure scoring function. Stub the heavy ones.
require.cache[require.resolve('../lib/prisma')] = { exports: {} };
require.cache[require.resolve('../middleware/auth')] = {
  exports: { verifyToken: (_q, _s, n) => n(), requireRole: () => (_q, _s, n) => n() },
};
const { scoreItems, toneFor } = require('./training.routes');

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION: the sim sends lowercase outcomes ('good' / 'issues' / 'skipped'
// — see web/src/sim/taskKit.jsx), but the score table was keyed with uppercase
// names. Every lookup missed, so every training run in the system scored 0% and
// the Training page's competency table was meaningless.
// ─────────────────────────────────────────────────────────────────────────────

test('all-good run scores 100, not 0', () => {
  const s = scoreItems([
    { procedure: 'good', understanding: 'good' },
    { procedure: 'good', understanding: 'good' },
  ]);
  assert.equal(s.scorePct, 100);
  assert.equal(s.tasksAttempted, 2);
  assert.equal(s.knowledgeGaps, 0);
});

test('lowercase "issues" is worth half credit', () => {
  const s = scoreItems([{ procedure: 'issues', understanding: 'issues' }]);
  assert.equal(s.scorePct, 50);
  assert.equal(s.knowledgeGaps, 1);
});

test('a task with no probe leans on procedure', () => {
  // understanding == null → knowledge score mirrors procedure
  assert.equal(scoreItems([{ procedure: 'good', understanding: null }]).scorePct, 100);
  assert.equal(scoreItems([{ procedure: 'issues', understanding: null }]).scorePct, 50);
});

test('skipped tasks score zero and do NOT count as attempted', () => {
  const s = scoreItems([
    { procedure: 'good', understanding: 'good' },
    { procedure: 'skipped', understanding: null },
  ]);
  assert.equal(s.tasksAttempted, 1, 'lowercase "skipped" must be recognised');
  assert.equal(s.scorePct, 50, 'one of two tasks done well');
});

test('uppercase outcomes are still accepted (older clients)', () => {
  assert.equal(scoreItems([{ procedure: 'GOOD', understanding: 'GOOD' }]).scorePct, 100);
  assert.equal(scoreItems([{ procedure: 'SKIPPED' }]).tasksAttempted, 0);
});

test('unknown or missing outcomes score zero rather than throwing', () => {
  assert.equal(scoreItems([{ procedure: 'banana' }]).scorePct, 0);
  assert.equal(scoreItems([{}]).scorePct, 0);
});

test('empty input is a zero, not a crash', () => {
  const s = scoreItems([]);
  assert.equal(s.scorePct, 0);
  assert.equal(s.tasksTotal, 0);
});

test('tone thresholds', () => {
  assert.equal(toneFor(100), 'great');
  assert.equal(toneFor(85), 'great');
  assert.equal(toneFor(84), 'ok');
  assert.equal(toneFor(60), 'ok');
  assert.equal(toneFor(59), 'bad');
});
