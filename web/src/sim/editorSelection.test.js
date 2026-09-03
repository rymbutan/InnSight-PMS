// Tests for the room-layout editor's multi-selection algebra and bulk operations.
//
// This module is deliberately React-free (like taskScore.js and inspectionScore.js)
// because the editor it serves is a 3D canvas that cannot be driven headlessly.
// Keeping the arithmetic here means the only untested surface left in the feature
// is wiring, not maths.
//
// Run: node --test web/src/sim/editorSelection.test.js

import test from 'node:test';
import assert from 'node:assert';

import {
  has,
  toggle,
  replace,
  rangeIn,
  selectAllLike,
  selectAllOfKind,
  selectAll,
  duplicateAll,
  deleteAll,
  nudgeAll,
  groupPivot,
  applyPivotDelta,
  countByKind,
} from './editorSelection.js';

// Walls store their position under `p`; furniture and stations use `pos`. Every
// bulk operation has to respect that or walls silently stop moving.
const arrays = () => ({
  furniture: [
    { model: 'bed', pos: [0, -2] },
    { model: 'rugBedroom', pos: [1, 1] },
    { model: 'rugBedroom', pos: [2, 1] },
    { model: 'rugBedroom', pos: [3, 1] },
    { type: 'drape', pos: [0, -4] },
  ],
  wall: [
    { p: [1, 0], w: 3, d: 0.16 },
    { p: [-1, 0], w: 2, d: 0.16 },
  ],
  station: [{ key: 's0', taskType: 'inspect', title: 'T', emoji: '⭐', pos: [4, 4] }],
});

const F = (i) => ({ kind: 'furniture', i });
const W = (i) => ({ kind: 'wall', i });

// ── selection algebra ───────────────────────────────────────────────────────

test('has() finds a reference already in the selection', () => {
  const sel = [F(0), W(1)];
  assert.equal(has(sel, 'furniture', 0), true);
  assert.equal(has(sel, 'wall', 1), true);
  assert.equal(has(sel, 'wall', 0), false);
  // same index, different kind — must not collide
  assert.equal(has(sel, 'station', 0), false);
});

test('toggle() adds a reference that is absent', () => {
  assert.deepEqual(toggle([], F(2)), [F(2)]);
  assert.deepEqual(toggle([F(0)], W(1)), [F(0), W(1)]);
});

test('toggle() removes a reference that is already selected', () => {
  assert.deepEqual(toggle([F(0), F(1)], F(0)), [F(1)]);
});

test('toggle() does not mutate the selection it was given', () => {
  const sel = [F(0)];
  toggle(sel, F(1));
  assert.deepEqual(sel, [F(0)], 'input array must be untouched');
});

test('replace() collapses the selection to one reference', () => {
  assert.deepEqual(replace(F(3)), [F(3)]);
});

test('rangeIn() selects an inclusive run within one kind', () => {
  assert.deepEqual(rangeIn([], 'furniture', 1, 3), [F(1), F(2), F(3)]);
});

test('rangeIn() works when the anchor is after the target', () => {
  assert.deepEqual(rangeIn([], 'furniture', 3, 1), [F(1), F(2), F(3)]);
});

test('rangeIn() merges into an existing selection without duplicating', () => {
  const out = rangeIn([F(2), W(0)], 'furniture', 1, 3);
  assert.equal(out.filter((r) => r.kind === 'furniture' && r.i === 2).length, 1);
  assert.equal(has(out, 'wall', 0), true, 'other kinds survive');
  assert.equal(out.filter((r) => r.kind === 'furniture').length, 3);
});

// ── bulk selection commands ─────────────────────────────────────────────────

test('selectAllLike() grabs every fixture sharing the model key', () => {
  const a = arrays();
  // the flooring case: one rug selected -> all three rugs
  const out = selectAllLike(a, F(1));
  assert.deepEqual(out, [F(1), F(2), F(3)]);
});

test('selectAllLike() matches primitive fixtures by their type key', () => {
  const a = arrays();
  a.furniture.push({ type: 'drape', pos: [9, 9] });
  const out = selectAllLike(a, F(4));
  assert.deepEqual(out, [F(4), F(5)]);
});

test('selectAllLike() on a non-furniture reference selects just that item', () => {
  const a = arrays();
  assert.deepEqual(selectAllLike(a, W(0)), [W(0)]);
});

test('selectAllOfKind() selects every index of one kind', () => {
  const a = arrays();
  assert.deepEqual(selectAllOfKind(a, 'wall'), [W(0), W(1)]);
});

test('selectAll() spans every kind — the move-the-whole-room case', () => {
  const a = arrays();
  const out = selectAll(a);
  assert.equal(out.length, 5 + 2 + 1);
  assert.equal(has(out, 'furniture', 4), true);
  assert.equal(has(out, 'wall', 1), true);
  assert.equal(has(out, 'station', 0), true);
});

test('countByKind() summarises a mixed selection for the panel', () => {
  assert.deepEqual(countByKind([F(0), F(1), W(0)]), { furniture: 2, wall: 1, station: 0 });
});

// ── duplicate ───────────────────────────────────────────────────────────────

test('duplicateAll() appends a copy of every selected fixture at an offset', () => {
  const a = arrays();
  const { arrays: next } = duplicateAll(a, [F(1), F(2)], 0.4);
  assert.equal(next.furniture.length, 7);
  assert.deepEqual(next.furniture[5].pos, [1.4, 1.4]);
  assert.deepEqual(next.furniture[6].pos, [2.4, 1.4]);
});

test('duplicateAll() preserves the relative arrangement of the copies', () => {
  const a = arrays();
  const { arrays: next } = duplicateAll(a, [F(1), F(3)], 0.4);
  const gapBefore = a.furniture[3].pos[0] - a.furniture[1].pos[0];
  const gapAfter = next.furniture[6].pos[0] - next.furniture[5].pos[0];
  assert.equal(gapAfter, gapBefore);
});

test('duplicateAll() offsets a wall via its `p` key, not `pos`', () => {
  const a = arrays();
  const { arrays: next } = duplicateAll(a, [W(0)], 0.4);
  assert.equal(next.wall.length, 3);
  assert.deepEqual(next.wall[2].p, [1.4, 0.4]);
  assert.equal(next.wall[2].pos, undefined);
});

test('duplicateAll() returns a selection pointing at the new copies', () => {
  const a = arrays();
  const { sel } = duplicateAll(a, [F(1), W(0)], 0.4);
  assert.deepEqual(sel, [F(5), W(2)]);
});

test('duplicateAll() deep-copies positions so the source cannot be aliased', () => {
  const a = arrays();
  const { arrays: next } = duplicateAll(a, [F(0)], 0.4);
  next.furniture[5].pos[0] = 99;
  assert.equal(a.furniture[0].pos[0], 0, 'original must not move');
});

test('duplicateAll() with an empty selection changes nothing', () => {
  const a = arrays();
  const { arrays: next, sel } = duplicateAll(a, [], 0.4);
  assert.deepEqual(next.furniture.length, 5);
  assert.deepEqual(sel, []);
});

// ── delete ──────────────────────────────────────────────────────────────────

test('deleteAll() removes several items of one kind despite index shifting', () => {
  const a = arrays();
  // naive sequential splicing would drop the wrong rows here
  const next = deleteAll(a, [F(0), F(2), F(4)]);
  assert.deepEqual(
    next.furniture.map((f) => f.model || f.type),
    ['rugBedroom', 'rugBedroom']
  );
  assert.deepEqual(next.furniture[0].pos, [1, 1]);
  assert.deepEqual(next.furniture[1].pos, [3, 1]);
});

test('deleteAll() removes across kinds at once', () => {
  const a = arrays();
  const next = deleteAll(a, [F(0), W(0), { kind: 'station', i: 0 }]);
  assert.equal(next.furniture.length, 4);
  assert.equal(next.wall.length, 1);
  assert.equal(next.station.length, 0);
  assert.deepEqual(next.wall[0].p, [-1, 0]);
});

// ── nudge ───────────────────────────────────────────────────────────────────

test('nudgeAll() moves every selected item by the same delta', () => {
  const a = arrays();
  const next = nudgeAll(a, [F(0), F(1)], 0.1, -0.1);
  assert.deepEqual(next.furniture[0].pos, [0.1, -2.1]);
  assert.deepEqual(next.furniture[1].pos, [1.1, 0.9]);
  assert.deepEqual(next.furniture[2].pos, [2, 1], 'unselected item stays put');
});

test('nudgeAll() moves a wall via its `p` key', () => {
  const a = arrays();
  const next = nudgeAll(a, [W(1)], 0.5, 0);
  assert.deepEqual(next.wall[1].p, [-0.5, 0]);
});

// ── group transform ─────────────────────────────────────────────────────────

test('groupPivot() is the centroid of the selection across kinds', () => {
  const a = arrays();
  // furniture[1] at (1,1) and wall[0] at (1,0) -> centroid (1, 0.5)
  assert.deepEqual(groupPivot(a, [F(1), W(0)]), [1, 0.5]);
});

test('groupPivot() of an empty selection is the origin', () => {
  assert.deepEqual(groupPivot(arrays(), []), [0, 0]);
});

test('applyPivotDelta() translates every selected item', () => {
  const a = arrays();
  const next = applyPivotDelta(a, [F(1), F(2)], [0, 0], { dx: 1, dz: 2, dRy: 0 });
  assert.deepEqual(next.furniture[1].pos, [2, 3]);
  assert.deepEqual(next.furniture[2].pos, [3, 3]);
});

test('applyPivotDelta() rotates positions about the pivot', () => {
  const a = arrays();
  // a single item 1m +x of the pivot, rotated 90° about Y, lands 1m -z of it.
  // three.js Y-rotation maps (x,z) -> (x·cos + z·sin, −x·sin + z·cos)
  const next = applyPivotDelta(a, [F(1)], [0, 1], { dx: 0, dz: 0, dRy: Math.PI / 2 });
  assert.ok(Math.abs(next.furniture[1].pos[0] - 0) < 1e-6, `x was ${next.furniture[1].pos[0]}`);
  assert.ok(Math.abs(next.furniture[1].pos[1] - 0) < 1e-6, `z was ${next.furniture[1].pos[1]}`);
});

test('applyPivotDelta() folds the rotation into each item ry', () => {
  const a = arrays();
  a.furniture[1].ry = 0.5;
  const next = applyPivotDelta(a, [F(1)], [1, 1], { dx: 0, dz: 0, dRy: 0.25 });
  assert.ok(Math.abs(next.furniture[1].ry - 0.75) < 1e-9);
});

test('applyPivotDelta() leaves an item sitting exactly on the pivot in place', () => {
  const a = arrays();
  const next = applyPivotDelta(a, [F(1)], [1, 1], { dx: 0, dz: 0, dRy: Math.PI / 3 });
  assert.ok(Math.abs(next.furniture[1].pos[0] - 1) < 1e-6);
  assert.ok(Math.abs(next.furniture[1].pos[1] - 1) < 1e-6);
});

test('applyPivotDelta() rotates walls about the pivot too', () => {
  const a = arrays();
  const next = applyPivotDelta(a, [W(0)], [0, 0], { dx: 0, dz: 0, dRy: Math.PI });
  assert.ok(Math.abs(next.wall[0].p[0] - -1) < 1e-6, `x was ${next.wall[0].p[0]}`);
  assert.ok(Math.abs(next.wall[0].p[1] - 0) < 1e-6);
});

test('applyPivotDelta() does not touch unselected items', () => {
  const a = arrays();
  const next = applyPivotDelta(a, [F(0)], [0, 0], { dx: 5, dz: 5, dRy: 1 });
  assert.deepEqual(next.furniture[1].pos, [1, 1]);
  assert.equal(next.furniture[1].ry, undefined);
});

test('applyPivotDelta() does not stamp an ry onto a station', () => {
  const a = arrays();
  // Stations have no rotation in their data model (stationLine never serialises
  // one), so folding the group rotation into them would invent a dead field.
  const next = applyPivotDelta(a, [{ kind: 'station', i: 0 }], [0, 0], { dx: 0, dz: 0, dRy: 1 });
  assert.equal(next.station[0].ry, undefined);
  assert.notDeepEqual(next.station[0].pos, [4, 4], 'but it must still orbit the pivot');
});
