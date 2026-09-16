import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GROUP_WITHIN_MS,
  clockTime,
  dayLabel,
  groupMessages,
  initialsOf,
  previewOf,
} from './messageGroups.js';

const ME = 'u-me';
const THEM = 'u-them';

// Local time, so the fixtures land on the same calendar day the grouping code
// computes. A UTC literal would drift across midnight depending on the machine's
// zone and make the day-separator tests pass or fail by geography.
function at(y, mo, d, h, mi, s = 0) {
  return new Date(y, mo - 1, d, h, mi, s).toISOString();
}
const msg = (id, senderId, createdAt, body = 'x') => ({ id, senderId, body, createdAt });
const groups = (rows) => rows.filter((r) => r.type === 'group');
const days = (rows) => rows.filter((r) => r.type === 'day');

test('an empty or malformed transcript groups into nothing', () => {
  assert.deepEqual(groupMessages([], ME), []);
  assert.deepEqual(groupMessages(null, ME), []);
  assert.deepEqual(groupMessages(undefined, ME), []);
  // A row with no id cannot be keyed for React, so it is skipped rather than
  // rendered as a bubble that warns on every paint.
  assert.deepEqual(groupMessages([{ senderId: ME, body: 'no id' }], ME), []);
});

test('consecutive messages from one sender inside the window are one turn', () => {
  // The reported symptom: three quick replies drawn as three separate islands,
  // each with its own clock time.
  const rows = groupMessages(
    [
      msg('m1', THEM, at(2026, 9, 16, 10, 0, 0), 'Hihi'),
      msg('m2', THEM, at(2026, 9, 16, 10, 0, 8), 'Chami'),
      msg('m3', THEM, at(2026, 9, 16, 10, 0, 20), 'Tamis anghang'),
    ],
    ME
  );
  const g = groups(rows);
  assert.equal(g.length, 1);
  assert.deepEqual(
    g[0].items.map((i) => i.body),
    ['Hihi', 'Chami', 'Tamis anghang']
  );
});

test('only the final bubble of a turn is marked last', () => {
  // `last` drives both the timestamp and the bubble's tail corner. If more than
  // one bubble claimed it, the turn would render with a stamp in its middle.
  const rows = groupMessages(
    [
      msg('m1', ME, at(2026, 9, 16, 10, 0, 0)),
      msg('m2', ME, at(2026, 9, 16, 10, 0, 5)),
      msg('m3', ME, at(2026, 9, 16, 10, 0, 9)),
    ],
    ME
  );
  assert.deepEqual(
    groups(rows)[0].items.map((i) => i.last),
    [false, false, true]
  );
});

test('a change of sender starts a new turn however close together they are', () => {
  const rows = groupMessages(
    [
      msg('m1', THEM, at(2026, 9, 16, 10, 0, 0)),
      msg('m2', ME, at(2026, 9, 16, 10, 0, 1)),
      msg('m3', THEM, at(2026, 9, 16, 10, 0, 2)),
    ],
    ME
  );
  assert.equal(groups(rows).length, 3);
  assert.deepEqual(
    groups(rows).map((g) => g.mine),
    [false, true, false]
  );
});

test('a pause longer than the window breaks the turn', () => {
  // The gap is information: it says the conversation stopped and restarted.
  const t0 = at(2026, 9, 16, 10, 0, 0);
  const justInside = new Date(new Date(t0).getTime() + GROUP_WITHIN_MS).toISOString();
  const justOutside = new Date(new Date(t0).getTime() + GROUP_WITHIN_MS + 1000).toISOString();

  assert.equal(groups(groupMessages([msg('a', ME, t0), msg('b', ME, justInside)], ME)).length, 1);
  assert.equal(groups(groupMessages([msg('a', ME, t0), msg('b', ME, justOutside)], ME)).length, 2);
});

test('the window is measured from the previous message, not the turn start', () => {
  // A steady trickle of replies two minutes apart is one continuous turn. Were
  // the window measured from the first message, it would split after five
  // minutes however unbroken the conversation was.
  const rows = groupMessages(
    [
      msg('m1', ME, at(2026, 9, 16, 10, 0)),
      msg('m2', ME, at(2026, 9, 16, 10, 2)),
      msg('m3', ME, at(2026, 9, 16, 10, 4)),
      msg('m4', ME, at(2026, 9, 16, 10, 6)),
      msg('m5', ME, at(2026, 9, 16, 10, 8)),
    ],
    ME
  );
  assert.equal(groups(rows).length, 1);
  assert.equal(groups(rows)[0].items.length, 5);
});

test('each calendar day gets exactly one separator, before its first message', () => {
  const rows = groupMessages(
    [
      msg('m1', ME, at(2026, 9, 14, 9, 0)),
      msg('m2', ME, at(2026, 9, 14, 9, 1)),
      msg('m3', ME, at(2026, 9, 15, 9, 0)),
      msg('m4', THEM, at(2026, 9, 16, 9, 0)),
    ],
    ME
  );
  assert.equal(days(rows).length, 3);
  // First row rendered is a separator, never a bubble with no date above it.
  assert.equal(rows[0].type, 'day');
});

test('a turn never straddles midnight', () => {
  // Same sender, two minutes apart, but on opposite sides of midnight: the
  // separator has to go between them, so the group must break even though both
  // the sender and the time window would otherwise keep it together.
  const rows = groupMessages(
    [msg('m1', ME, at(2026, 9, 15, 23, 59)), msg('m2', ME, at(2026, 9, 16, 0, 1))],
    ME
  );
  assert.equal(groups(rows).length, 2);
  assert.equal(days(rows).length, 2);
});

test('groups carry no internal bookkeeping for the renderer to depend on', () => {
  const rows = groupMessages([msg('m1', ME, at(2026, 9, 16, 10, 0))], ME);
  assert.equal(Object.prototype.hasOwnProperty.call(groups(rows)[0], 'lastAt'), false);
});

test('every row has a unique key', () => {
  // Two messages in the same second used to be able to collide when the key was
  // built from the timestamp alone; keys are built from the message id.
  const rows = groupMessages(
    [
      msg('m1', ME, at(2026, 9, 16, 10, 0, 0)),
      msg('m2', THEM, at(2026, 9, 16, 10, 0, 0)),
      msg('m3', ME, at(2026, 9, 16, 10, 0, 0)),
    ],
    ME
  );
  const keys = rows.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('dayLabel reads as today, yesterday, a weekday, then a date', () => {
  const now = new Date(2026, 8, 16, 12, 0); // 16 Sep 2026, a Wednesday
  assert.equal(dayLabel(at(2026, 9, 16, 8, 0), now), 'Today');
  assert.equal(dayLabel(at(2026, 9, 15, 8, 0), now), 'Yesterday');
  // Two to six days back is named by weekday — the handle a reader actually has.
  assert.equal(dayLabel(at(2026, 9, 14, 8, 0), now), 'Monday');
  // A week or more back needs the date; it must not say "Wednesday" for a
  // Wednesday nine days ago.
  const old = dayLabel(at(2026, 9, 7, 8, 0), now);
  assert.match(old, /7/);
  assert.doesNotMatch(old, /Monday|Wednesday/);
  // A different year says which.
  assert.match(dayLabel(at(2025, 12, 31, 8, 0), now), /2025/);
});

test('dayLabel is computed against the date passed in, not the wall clock', () => {
  // A thread left open across midnight can be relabelled by passing the new
  // date; "Today" is not frozen at page load.
  const iso = at(2026, 9, 16, 23, 0);
  assert.equal(dayLabel(iso, new Date(2026, 8, 16, 23, 30)), 'Today');
  assert.equal(dayLabel(iso, new Date(2026, 8, 17, 0, 30)), 'Yesterday');
});

test('a bad timestamp yields an empty label rather than "Invalid Date"', () => {
  assert.equal(dayLabel('not a date'), '');
  assert.equal(clockTime('not a date'), '');
});

test('previewOf collapses whitespace so a pasted note stays one readable line', () => {
  // Without the collapse the newline renders as nothing and the words join up.
  assert.equal(previewOf('Room 204\ndone'), 'Room 204 done');
  assert.equal(previewOf('  spaced   out  '), 'spaced out');
  assert.equal(previewOf('Room\t204\r\nready'), 'Room 204 ready');
});

test('previewOf truncates on a word boundary and marks the cut', () => {
  const long = 'Nagambagan kami nina arym ng pansit and then the conversation kept going for a while';
  const p = previewOf(long, 30);
  assert.ok(p.length <= 31, `got ${p.length}: ${p}`);
  assert.ok(p.endsWith('…'));
  // The kept text must be a WHOLE-WORD prefix of the original: the character
  // following it in the source is a space, so no word was sliced down the
  // middle. Checking the last character before the ellipsis is not the test —
  // a complete word legitimately ends in a letter.
  const kept = p.slice(0, -1);
  assert.ok(long.startsWith(kept), `"${kept}" is not a prefix of the original`);
  assert.equal(long[kept.length], ' ');
});

test('previewOf falls back to a hard cut when one word fills the whole budget', () => {
  // A pasted URL or a 40-character room code has no space to break on. Better a
  // mid-word cut than a preview that blows past the row it has to fit in.
  const p = previewOf('A'.repeat(80), 30);
  assert.ok(p.length <= 31, `got ${p.length}`);
  assert.ok(p.endsWith('…'));
});

test('previewOf leaves a short line completely alone', () => {
  assert.equal(previewOf('Hihi'), 'Hihi');
  assert.equal(previewOf(''), '');
  assert.equal(previewOf(null), '');
  assert.equal(previewOf(undefined), '');
});

test('initialsOf handles one name, many names, and nothing at all', () => {
  assert.equal(initialsOf('Monte Salvanera'), 'MS');
  assert.equal(initialsOf('Maria Clara Santos'), 'MS');
  assert.equal(initialsOf('admin'), 'A');
  assert.equal(initialsOf('  padded  name  '), 'PN');
  assert.equal(initialsOf(''), '?');
  assert.equal(initialsOf(), '?');
});
