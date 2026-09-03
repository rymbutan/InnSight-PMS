const test = require('node:test');
const assert = require('node:assert');

const { leafFacilityIds } = require('./conflictScope');

test('a facility with no children occupies only itself', () => {
  assert.deepEqual(leafFacilityIds({ id: 'mtg' }, []), ['mtg']);
});

test('a parent occupies all of its children, not itself', () => {
  const leaves = leafFacilityIds({ id: 'hall' }, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.deepEqual(leaves.sort(), ['a', 'b', 'c']);
});

test('undefined children behave as no children', () => {
  assert.deepEqual(leafFacilityIds({ id: 'gym' }, undefined), ['gym']);
});
