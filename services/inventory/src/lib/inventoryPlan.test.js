const test = require('node:test');
const assert = require('node:assert');
const { planInventory } = require('./inventoryPlan');

// The real seed mix, so the expectations below are the numbers that ship.
const TYPES = [
  { code: 'STD', perFloor: 8 },
  { code: 'DLX', perFloor: 4 },
  { code: 'STE', perFloor: 2 },
  { code: 'PRS', perFloor: 1 },
];

test('numbers rooms as floor*100 + index on that floor', () => {
  const { rooms } = planInventory(2, TYPES);
  assert.equal(rooms.length, 30);
  assert.equal(rooms[0].number, '101');
  assert.equal(rooms[14].number, '115');
  assert.equal(rooms[15].number, '201');
  assert.equal(rooms[15].floor, 2);
});

test('totalInventory tracks the floor count', () => {
  const { rooms, totals } = planInventory(4, TYPES);
  assert.deepEqual(totals, { STD: 32, DLX: 16, STE: 8, PRS: 4 });
  assert.equal(rooms.length, 60);
});

test('a fourth floor keeps floors 1-3 numbered exactly as before', () => {
  // The rooms already in the database must keep their numbers and types, or the
  // upserting seed silently retypes occupied rooms.
  const three = planInventory(3, TYPES);
  const four = planInventory(4, TYPES);
  assert.deepEqual(four.rooms.slice(0, three.rooms.length), three.rooms);
});

test('every room on a floor gets a type from the mix', () => {
  const { rooms } = planInventory(1, TYPES);
  assert.equal(rooms.filter((r) => r.typeCode === 'STD').length, 8);
  assert.equal(rooms.filter((r) => r.typeCode === 'PRS').length, 1);
  assert.ok(rooms.every((r) => r.floor === 1));
});
