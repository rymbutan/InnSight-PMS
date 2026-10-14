// Tests for the layout editor's pure inspector helpers.
// Run: node --test web/src/sim/editorMath.test.js

import test from 'node:test';
import assert from 'node:assert';
import { uniqueStationKey, parseDraft, atLeast, clampSpawn, nonZeroScale } from './editorMath.js';
import { duplicateAll } from './editorSelection.js';

test('uniqueStationKey starts at the array length', () => {
  assert.equal(uniqueStationKey([]), 'custom0');
  assert.equal(uniqueStationKey([{ key: 'a' }, { key: 'b' }]), 'custom2');
});

test('uniqueStationKey skips a key already taken after a delete', () => {
  // custom0 was deleted, custom1 remains: length is 1, so naive `custom1` collides.
  assert.equal(uniqueStationKey([{ key: 'custom1' }]), 'custom2');
  assert.equal(uniqueStationKey([{ key: 'custom2' }, { key: 'custom3' }, { key: 'x' }]), 'custom4');
});

test('parseDraft returns null for half-typed text, never 0', () => {
  for (const s of ['', ' ', '-', '.', '-.', '1e', 'abc', null, undefined]) assert.equal(parseDraft(s), null);
  assert.equal(parseDraft('-'), null);
});

test('parseDraft accepts negatives and decimals', () => {
  assert.equal(parseDraft('-2.5'), -2.5);
  assert.equal(parseDraft('0'), 0);
  assert.equal(parseDraft(' 3 '), 3);
  assert.equal(parseDraft('.5'), 0.5);
});

test('atLeast floors a value, null min is a no-op', () => {
  assert.equal(atLeast(0, 0.1), 0.1);
  assert.equal(atLeast(-4, 0.1), 0.1);
  assert.equal(atLeast(2, 0.1), 2);
  assert.equal(atLeast(-4, null), -4);
});

test('clampSpawn pulls an outside spawn into the room', () => {
  const r = clampSpawn({ w: 4, l: 6, spawn: [5, -9] });
  assert.deepEqual(r.spawn, [2, -3]);
});

test('clampSpawn returns the same object when already inside', () => {
  const room = { w: 4, l: 6, spawn: [1, 1] };
  assert.equal(clampSpawn(room), room);
});

test('clampSpawn follows a shrinking room', () => {
  const room = { w: 10, l: 10, spawn: [4, 4] };
  assert.deepEqual(clampSpawn({ ...room, w: 2, l: 3 }).spawn, [1, 1.5]);
});

test('duplicateAll gives cloned stations fresh unique keys', () => {
  const arrays = {
    furniture: [],
    wall: [],
    station: [
      { key: 'custom0', title: 'A', pos: [0, 0] },
      { key: 'bed', title: 'B', pos: [1, 1] },
    ],
  };
  const { arrays: next } = duplicateAll(
    arrays,
    [
      { kind: 'station', i: 0 },
      { kind: 'station', i: 1 },
    ],
    0.4
  );
  const keys = next.station.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.length, 4);
  assert.equal(next.station[0].key, 'custom0'); // originals untouched
});

test('nonZeroScale keeps mirrors but never collapses to zero', () => {
  assert.equal(nonZeroScale(0), 0.01);
  assert.equal(nonZeroScale(-0.001), -0.01);
  assert.equal(nonZeroScale(-1.1), -1.1);
  assert.equal(nonZeroScale(2), 2);
});
