import test from 'node:test';
import assert from 'node:assert/strict';

import { ON_FILL_INK, ON_FILL_INK_SOFT, STATUS_META, STATUS_ORDER, statusMeta } from './statusMeta.js';

// ─────────────────────────────────────────────────────────────────────────────
// This is the one source of truth for what a room status LOOKS like, precisely
// so that two screens showing the same room never disagree about its colour.
// That guarantee only holds if every caller actually goes through statusMeta()
// rather than re-deriving a colour from the status string itself — which is
// exactly how the Hotel Room Information Editor and the reservation calendar
// board each grew their own `.badge`/`.status-dot` modifier, and how OCCUPIED
// ended up the same green as CLEAN on one screen while the Map & Housekeeping
// board (which does go through statusMeta) drew it violet. The two screens
// looked equally confident and said opposite things about the same room.
//
// This file cannot see every caller, so it guards the one thing a caller
// cannot get right if THIS is wrong: the table itself. If two statuses ever
// share a colour again, whichever screen still hand-rolls its own palette
// will reproduce the exact bug this fixed — this test is what would catch it
// before a screenshot does.
// ─────────────────────────────────────────────────────────────────────────────

test('every status the app uses has its own entry, not the generic fallback', () => {
  for (const s of STATUS_ORDER) {
    assert.ok(STATUS_META[s], `${s} has no STATUS_META entry`);
  }
});

test('no two statuses share a colour', () => {
  const byColor = new Map();
  for (const s of STATUS_ORDER) {
    const { color } = statusMeta(s);
    const clashing = byColor.get(color);
    assert.ok(!clashing, `${s} and ${clashing} both render as ${color}`);
    byColor.set(color, s);
  }
});

test('no two statuses share a fill', () => {
  const byFill = new Map();
  for (const s of STATUS_ORDER) {
    const { fill } = statusMeta(s);
    const clashing = byFill.get(fill);
    assert.ok(!clashing, `${s} and ${clashing} both fill as ${fill}`);
    byFill.set(fill, s);
  }
});

test('OCCUPIED is not the same colour as CLEAN — a guest in residence must not read as an all-clear', () => {
  assert.notEqual(statusMeta('OCCUPIED').color, statusMeta('CLEAN').color);
  assert.notEqual(statusMeta('OCCUPIED').fill, statusMeta('CLEAN').fill);
});

test('OUT_OF_ORDER is not the same colour as DIRTY — one blocks a sale, the other blocks a whole room', () => {
  assert.notEqual(statusMeta('OUT_OF_ORDER').color, statusMeta('DIRTY').color);
});

test('every entry carries what a caller needs to render it: code, label, color, fill, hint', () => {
  for (const s of STATUS_ORDER) {
    const m = statusMeta(s);
    assert.equal(typeof m.code, 'string');
    assert.ok(m.code.length > 0, `${s} has an empty code`);
    assert.equal(typeof m.label, 'string');
    assert.match(m.color, /^#[0-9a-f]{6}$/i, `${s}.color is not a hex colour`);
    assert.match(m.fill, /^#[0-9a-f]{6}$/i, `${s}.fill is not a hex colour`);
    assert.equal(typeof m.hint, 'string');
  }
});

test('an unrecognised status degrades to the neutral fallback rather than throwing', () => {
  const m = statusMeta('SOMETHING_NEW');
  assert.equal(m.code, 'SOMETHING_NEW');
  assert.equal(m.label, 'SOMETHING_NEW');
  assert.match(m.color, /^#[0-9a-f]{6}$/i);
  assert.match(m.fill, /^#[0-9a-f]{6}$/i);
});

test('the ink constants are real colours, for the text drawn on a status fill', () => {
  assert.match(ON_FILL_INK, /^#[0-9a-f]{6}$/i);
  assert.match(ON_FILL_INK_SOFT, /^#[0-9a-f]{6}$/i);
});
