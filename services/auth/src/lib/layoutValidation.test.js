const test = require('node:test');
const assert = require('node:assert');

const { validate } = require('./layoutValidation');

const good = () => ({
  room: { w: 5, l: 6, h: 3, spawn: [0, 0] },
  furniture: [{ model: 'bed', pos: [1, 2], scale: [1, 1, 1] }],
  walls: [{ p: [0, 0], w: 2, d: 0.2 }],
  stations: [],
});

test('accepts a well-formed layout', () => {
  assert.equal(validate(good()), null);
});

test('rejects zero, negative and non-numeric room dimensions', () => {
  for (const bad of [0, -3, '5', NaN, null]) {
    const b = good();
    b.room.w = bad;
    assert.match(validate(b), /room\.w and room\.l/);
    const c = good();
    c.room.l = bad;
    assert.match(validate(c), /room\.w and room\.l/);
  }
});

test('rejects a non-positive room height but allows it to be absent', () => {
  const b = good();
  b.room.h = 0;
  assert.match(validate(b), /room\.h/);
  const c = good();
  delete c.room.h;
  assert.equal(validate(c), null);
});

test('rejects a spawn that is not two finite numbers', () => {
  const b = good();
  b.room.spawn = [0, NaN];
  assert.match(validate(b), /spawn/);
});

test('allows a mirrored (negative) fixture scale', () => {
  const b = good();
  b.furniture[0].scale = [-1, 1.2, -0.4];
  assert.equal(validate(b), null);
});

test('rejects a zero fixture scale', () => {
  const b = good();
  b.furniture[0].scale = [1, 0, 1];
  assert.match(validate(b), /scale/);
});

test('rejects a wall with zero or negative size', () => {
  const b = good();
  b.walls[0].w = 0;
  assert.match(validate(b), /wall/);
  const c = good();
  c.walls[0].d = -1;
  assert.match(validate(c), /wall/);
});
