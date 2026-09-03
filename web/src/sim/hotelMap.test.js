import test from 'node:test';
import assert from 'node:assert/strict';

import { computeLayout, MAP_W } from './hotelMap.js';

/** The seeded property: 15 rooms a floor, 8 STD / 4 DLX / 2 STE / 1 PRS. */
function property(floors = 3) {
  const rooms = [];
  for (let f = 1; f <= floors; f += 1) {
    let idx = 0;
    for (const [code, n] of [['STD', 8], ['DLX', 4], ['STE', 2], ['PRS', 1]]) {
      for (let i = 0; i < n; i += 1) {
        idx += 1;
        const number = String(f * 100 + idx);
        rooms.push({ id: number, number, typeCode: code, floor: f, status: 'CLEAN' });
      }
    }
  }
  return rooms;
}

const widths = (slots) => [...new Set(slots.map((s) => s.w))];

test('every room in the property is placed exactly once', () => {
  const rooms = property(3);
  const { slots } = computeLayout(rooms);
  assert.equal(slots.length, rooms.length);
  assert.equal(new Set(slots.map((s) => s.room.id)).size, rooms.length);
});

test('each floor gets its own wing', () => {
  const { floors } = computeLayout(property(3));
  assert.deepEqual(floors.map((f) => f.floor), [1, 2, 3]);
  assert.deepEqual(floors.map((f) => f.count), [15, 15, 15]);
});

test('rooms on different floors never share a corridor', () => {
  // 115 and 201 used to sit side by side on one corridor, as though a
  // Presidential suite and a Standard on the floor above were neighbours.
  const { slots } = computeLayout(property(3));
  const at = (n) => slots.find((s) => s.room.number === n);
  assert.notEqual(at('115').y, at('201').y);
  assert.ok(at('201').y > at('115').y, 'floor 2 is drawn below floor 1');
});

test('a room is never squeezed below a legible width', () => {
  // THE BUG THIS FIXES. Forty-five rooms in two rows gave 55px each, and
  // "Standard" rendered as "Standar" over the top of its neighbour.
  for (const n of [1, 2, 3, 6, 10]) {
    const { slots } = computeLayout(property(n));
    for (const s of slots) assert.ok(s.w >= 96, `${n} floors → ${s.w}px rooms`);
  }
});

test('the seeded property still fits without scrolling', () => {
  // 8 rooms in the top row of each floor is exactly what MAP_W was sized for.
  const { mapW, slots } = computeLayout(property(3));
  assert.equal(mapW, MAP_W);
  assert.deepEqual(widths(slots), [109]);
});

test('a floor too wide to fit grows the map instead of shrinking the rooms', () => {
  const wide = [];
  for (let i = 1; i <= 40; i += 1) {
    wide.push({ id: `1${i}`, number: String(100 + i), typeCode: 'STD', floor: 1, status: 'CLEAN' });
  }
  const { mapW, slots } = computeLayout(wide);
  assert.ok(mapW > MAP_W, 'the drawing widens so the panel can scroll it');
  for (const s of slots) assert.ok(s.w >= 96);
});

test('one column width is used across the whole map', () => {
  // Otherwise each floor draws its own grid and the columns stop lining up.
  const mixed = [
    ...property(1),
    { id: '201', number: '201', typeCode: 'STD', floor: 2, status: 'CLEAN' },
    { id: '202', number: '202', typeCode: 'STD', floor: 2, status: 'CLEAN' },
  ];
  assert.equal(widths(computeLayout(mixed).slots).length, 1);
});

test('a small floor does not become a row of billboards', () => {
  const tiny = [{ id: '101', number: '101', typeCode: 'PRS', floor: 1, status: 'CLEAN' }];
  const { slots } = computeLayout(tiny);
  assert.ok(slots[0].w <= 150);
});

test('a short row is centred rather than left ragged', () => {
  const { slots } = computeLayout(property(1));
  const top = slots.filter((s) => s.row === 0).sort((a, b) => a.x - b.x);
  const bot = slots.filter((s) => s.row === 1).sort((a, b) => a.x - b.x);
  assert.equal(top.length, 8);
  assert.equal(bot.length, 7);
  const centre = (row) => (row[0].x + row[row.length - 1].x + row[0].w) / 2;
  assert.ok(Math.abs(centre(top) - centre(bot)) < 1, 'both rows share a centre line');
});

test('the two rows of a floor sit either side of its corridor', () => {
  const { slots, floors } = computeLayout(property(2));
  for (const f of floors) {
    const mine = slots.filter((s) => String(s.room.floor) === String(f.floor));
    for (const s of mine.filter((x) => x.row === 0)) assert.ok(s.y + s.h <= f.corridorY);
    for (const s of mine.filter((x) => x.row === 1)) assert.ok(s.y >= f.corridorY);
  }
});

test('the map is tall enough for everything drawn on it', () => {
  for (const n of [1, 2, 3, 5]) {
    const { slots, mapH } = computeLayout(property(n));
    for (const s of slots) assert.ok(s.y + s.h <= mapH, `${n} floors: a room falls off the map`);
  }
});

test('an empty property renders an empty map instead of throwing', () => {
  const out = computeLayout([]);
  assert.deepEqual(out.slots, []);
  assert.deepEqual(out.floors, []);
  assert.ok(out.mapH > 0);
});

test('a room with no floor is placed rather than dropped', () => {
  const { slots, floors } = computeLayout([{ id: 'x', number: '9', typeCode: 'STD', status: 'CLEAN' }]);
  assert.equal(slots.length, 1);
  assert.equal(floors[0].floor, 1);
});

test('floors are ordered numerically, not by insertion or string order', () => {
  const rooms = [10, 2, 1].flatMap((f) => [
    { id: `${f}01`, number: `${f}01`, typeCode: 'STD', floor: f, status: 'CLEAN' },
  ]);
  assert.deepEqual(computeLayout(rooms).floors.map((f) => f.floor), [1, 2, 10]);
});

test('rooms within a floor are ordered numerically', () => {
  // '10' must not sort before '9' — the map reads left to right by room number.
  const rooms = [111, 12, 9, 100].map((n) => ({
    id: String(n), number: String(n), typeCode: 'STD', floor: 1, status: 'CLEAN',
  }));
  const top = computeLayout(rooms).slots.filter((s) => s.row === 0).sort((a, b) => a.x - b.x);
  assert.deepEqual(top.map((s) => s.room.number), ['9', '12']);
});
