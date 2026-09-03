import test from 'node:test';
import assert from 'node:assert';
import { LAYOUTS, getRoomPlan, setRoomLayouts, hasServerLayouts, storedLayoutFor } from './roomLayouts.js';

// The shared store replaced per-browser localStorage. These pin the two things
// that made that change worth doing: the code layout is the default, and one
// stored row is the truth for every browser reading it.

const reset = () => setRoomLayouts([]);

test('with nothing stored, the committed layout is what everyone gets', () => {
  reset();
  assert.equal(hasServerLayouts(), false);
  assert.equal(getRoomPlan('Standard').furniture.length, LAYOUTS.Standard.furniture.length);
  assert.equal(storedLayoutFor('Standard'), null);
});

test('a stored layout replaces the committed one for that tier only', () => {
  reset();
  setRoomLayouts([
    {
      roomTier: 'Standard',
      room: { w: 5, l: 5, h: 2.4, floor: '#111', spawn: [1, 1] },
      furniture: [{ model: 'bed', pos: [0, 0] }],
      walls: [],
      stations: [],
    },
  ]);
  const std = getRoomPlan('Standard');
  assert.equal(std.furniture.length, 1);
  assert.equal(std.w, 5);
  assert.deepEqual(std.spawn, [1, 1]);
  // Untouched tiers keep the code layout — a stored Standard must not leak.
  assert.equal(getRoomPlan('Deluxe').furniture.length, LAYOUTS.Deluxe.furniture.length);
  reset();
});

test('a room-type name still resolves to its tier', () => {
  reset();
  setRoomLayouts([
    {
      roomTier: 'Deluxe',
      room: { w: 9, l: 9, spawn: [0, 0] },
      furniture: [{ model: 'bed', pos: [0, 0] }],
      walls: [],
      stations: [],
    },
  ]);
  // "Deluxe King" is a room TYPE; the layout is per tier.
  assert.equal(getRoomPlan('Deluxe King').w, 9);
  reset();
});

test('an empty stations array is honoured, not treated as unset', () => {
  reset();
  // The authored Standard deliberately has no task stations. Falling back to the
  // committed ones would put markers back that were removed on purpose.
  setRoomLayouts([
    {
      roomTier: 'Presidential',
      room: { w: 12, l: 15, spawn: [0, 0] },
      furniture: [{ model: 'bed', pos: [0, 0] }],
      walls: [],
      stations: [],
    },
  ]);
  assert.deepEqual(getRoomPlan('Presidential').stations, []);
  reset();
});

test('a malformed row is ignored rather than breaking the room', () => {
  reset();
  setRoomLayouts([
    { roomTier: 'Standard', room: null, furniture: null },
    { roomTier: 'NotATier', room: { w: 1, l: 1 }, furniture: [] },
    null,
  ]);
  assert.equal(getRoomPlan('Standard').furniture.length, LAYOUTS.Standard.furniture.length);
  assert.equal(hasServerLayouts(), false);
});

test('re-hydrating replaces rather than merges', () => {
  reset();
  setRoomLayouts([
    { roomTier: 'Standard', room: { w: 5, l: 5, spawn: [0, 0] }, furniture: [], walls: [], stations: [] },
  ]);
  assert.equal(getRoomPlan('Standard').w, 5);
  setRoomLayouts([]); // server now has nothing — the code layout must return
  assert.equal(getRoomPlan('Standard').w, LAYOUTS.Standard.w);
});
