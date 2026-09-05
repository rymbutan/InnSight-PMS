const test = require('node:test');
const assert = require('node:assert');

const { movementCount } = require('./movements');

test('counts the arrivals envelope', () => {
  assert.equal(movementCount({ range: 'today', degraded: false, arrivals: [{}, {}, {}] }), 3);
});

test('still counts a bare array, which /api/departures returns', () => {
  assert.equal(movementCount([{}, {}]), 2);
});

test('an empty envelope counts zero', () => {
  assert.equal(movementCount({ range: 'today', degraded: false, arrivals: [] }), 0);
});

// The regression this file exists for: reading .length off an envelope gave
// undefined, and undefined was written into the audit record as the count.
test('never returns undefined for a malformed or failed payload', () => {
  for (const bad of [null, undefined, {}, 'nope', 0]) {
    assert.equal(movementCount(bad), 0, `${JSON.stringify(bad)} must count 0, never undefined`);
  }
});
