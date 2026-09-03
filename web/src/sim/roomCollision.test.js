// Tests for the walk-collision model shared by the free-roam room and the
// inspection case study.
//
// This logic used to live inside RoomFreeRoam.jsx, which imports three.js and
// therefore cannot be loaded in a node test — so the rule that decides whether a
// student can move had no coverage at all. That is how a permanent movement trap
// survived: blocked() only ever tested the DESTINATION, so a player who ended up
// inside a collision box found every candidate position blocked too and could
// never walk out.
//
// Run: node --test web/src/sim/roomCollision.test.js

import test from 'node:test';
import assert from 'node:assert';

import { blockersOf, wallBlockers, blocked, resolveMove, PAD } from './roomCollision.js';

// ── what counts as solid ────────────────────────────────────────────────────

test('a model fixture with an explicit box is solid', () => {
  const b = blockersOf([{ model: 'bed', pos: [0, 0], box: [2, 2] }]);
  assert.equal(b.length, 1);
  assert.deepEqual(b[0].slice(0, 4), [-1, 1, -1, 1]);
});

test('a model fixture with no box is NOT solid — wall art, décor, on-surface items', () => {
  assert.deepEqual(blockersOf([{ model: 'art', pos: [0, 0], wall: true }]), []);
});

test('a primitive scenario prop is never solid', () => {
  // Scenario props must never be able to trap a student: the fault is judged by
  // eye, not by walking into it.
  assert.deepEqual(blockersOf([{ prim: 'vacuum', pos: [0, 0], size: [0.4, 1, 0.4] }]), []);
});

test('a typed fixture is solid only when its footprint says so', () => {
  const solid = blockersOf([{ type: 'console', pos: [0, 0] }]);
  const soft = blockersOf([{ type: 'drape', pos: [0, 0], s: [4, 2.6] }]);
  assert.equal(solid.length, 1, 'console is furniture you bump into');
  assert.equal(soft.length, 0, 'a drape is cloth');
});

test('an editor resize is honoured so collision matches the visual', () => {
  const b = blockersOf([{ model: 'bed', pos: [0, 0], box: [2, 2], scale: [2, 1, 3] }]);
  assert.deepEqual(b[0].slice(0, 4), [-2, 2, -3, 3]);
});

test('a fixture rotated ~90 degrees swaps its footprint axes', () => {
  const b = blockersOf([{ model: 'sofa3', pos: [0, 0], box: [2, 1], ry: Math.PI / 2 }]);
  assert.deepEqual(b[0].slice(0, 4), [-0.5, 0.5, -1, 1]);
});

test('blockersOf records what each blocker came from, for diagnostics', () => {
  const b = blockersOf([{ model: 'bed', pos: [0, 0], box: [2, 2] }]);
  assert.equal(b[0][4], 'bed');
});

test('wallBlockers turns interior walls into boxes', () => {
  const b = wallBlockers([{ p: [1, 0], w: 4, d: 0.2 }]);
  assert.deepEqual(b[0].slice(0, 4), [-1, 3, -0.1, 0.1]);
});

// ── the move rule ───────────────────────────────────────────────────────────

const box = blockersOf([{ model: 'bed', pos: [0, 0], box: [2, 2] }]); // −1..1 on both axes

test('a move through open floor is allowed', () => {
  assert.deepEqual(resolveMove([5, 5], [5.2, 5.2], box), [5.2, 5.2]);
});

test('a move into a solid fixture is refused', () => {
  // approaching from +x: the pad stops you short of the box face
  assert.deepEqual(resolveMove([3, 0], [1 + PAD - 0.01, 0], box), [3, 0]);
});

test('movement resolves per axis so you slide along a fixture instead of sticking', () => {
  // pushing diagonally into the box's +x face: x is refused, z still advances
  const [x, z] = resolveMove([2, 0], [1, 0.5], box);
  assert.equal(x, 2, 'blocked axis holds');
  assert.equal(z, 0.5, 'free axis still moves');
});

test('a player already inside a fixture can move out — the escape rule', () => {
  // THE BUG: without this, every candidate position inside the box is blocked
  // too, so the student is trapped for the rest of the shift.
  assert.equal(blocked(0, 0, box), true, 'precondition: standing inside');
  assert.deepEqual(resolveMove([0, 0], [0.5, 0.5], box), [0.5, 0.5]);
});

test('escaping works in whichever direction the player walks', () => {
  assert.deepEqual(resolveMove([0, 0], [-0.6, 0], box), [-0.6, 0]);
  assert.deepEqual(resolveMove([0, 0], [0, -0.6], box), [0, -0.6]);
});

test('once out, the fixture is solid again — escape is not a free pass', () => {
  const out = resolveMove([0, 0], [3, 0], box); // walked out along +x
  assert.deepEqual(out, [3, 0]);
  // Genuinely outside now, so stepping back toward the box centre is refused
  // again. The escape rule must not leave the fixture permanently passable.
  assert.deepEqual(resolveMove(out, [1, 0], box), [3, 0]);
});

test('an empty room never blocks anything', () => {
  assert.deepEqual(resolveMove([0, 0], [1, 1], []), [1, 1]);
});
