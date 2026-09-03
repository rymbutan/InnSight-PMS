// Tests for the swappable-asset families used by the scenario builder.
//
// Building a scenario used to mean: delete the clean fixture, add the faulted
// one from a 71-entry alphabetical dropdown, then drag it back to where the
// original stood. Three steps, and the third one is exactly the "scenario moved
// my furniture" problem. A family lets the teacher swap the ASSET in place.
//
// Run: node --test web/src/sim/inspection/assetFamilies.test.js

import test from 'node:test';
import assert from 'node:assert';

import { familyOf, variantsFor, isVariantOf, labelFor, FAMILIES } from './assetFamilies.js';
import { MODEL_FILES } from '../modelSizes.js';

test('every key named in a family is a real registered model', () => {
  // A family entry pointing at a model that does not exist would render an empty
  // group and look like the swap silently failed.
  for (const [name, keys] of Object.entries(FAMILIES)) {
    for (const k of keys) {
      assert.ok(MODEL_FILES[k], `family "${name}" names unregistered model "${k}"`);
    }
  }
});

test('a fixture finds the family it belongs to', () => {
  assert.equal(familyOf('bed'), 'bed');
  assert.equal(familyOf('messybed'), 'bed');
  assert.equal(familyOf('dirtytoilet'), 'toilet');
});

test('a fixture in no family returns null rather than guessing', () => {
  assert.equal(familyOf('wardrobe'), null);
  assert.equal(familyOf(undefined), null);
});

test('variantsFor offers the alternatives WITHOUT the current asset', () => {
  const v = variantsFor('bed');
  assert.ok(v.length > 0);
  assert.ok(!v.includes('bed'), 'the fixture you already have is not an alternative');
  assert.ok(v.includes('messybed'));
});

test('variantsFor works from any member, not just the clean one', () => {
  // Selecting the messy bed must offer its way back to the clean bed.
  const v = variantsFor('messybed');
  assert.ok(v.includes('bed'), 'can always swap back to the clean asset');
  assert.ok(!v.includes('messybed'));
});

test('variantsFor on an unfamiliar fixture is empty, not everything', () => {
  assert.deepEqual(variantsFor('wardrobe'), []);
});

test('isVariantOf recognises two members of the same family', () => {
  assert.equal(isVariantOf('bed', 'messybed'), true);
  assert.equal(isVariantOf('messybed', 'dirtymattress'), true);
  assert.equal(isVariantOf('bed', 'toilet'), false);
});

test('the clean asset is listed first in every family', () => {
  // The editor renders families in order, and the first entry is the "reset to
  // correct" affordance — it must not be a faulted asset.
  const dirty = /messy|dirty|unmade|floor|empty|clutter|trash/i;
  for (const [name, keys] of Object.entries(FAMILIES)) {
    assert.ok(!dirty.test(keys[0]), `family "${name}" leads with faulted asset "${keys[0]}"`);
  }
});

test('no model belongs to two families', () => {
  // Overlap would make familyOf() order-dependent and the swap list unstable.
  const seen = new Map();
  for (const [name, keys] of Object.entries(FAMILIES)) {
    for (const k of keys) {
      assert.ok(!seen.has(k), `"${k}" is in both "${seen.get(k)}" and "${name}"`);
      seen.set(k, name);
    }
  }
});

test('the fault assets that shipped are reachable from some family', () => {
  // Otherwise a teacher can only reach them through the raw 71-entry dropdown,
  // which is the problem this module exists to remove.
  const inAFamily = new Set(Object.values(FAMILIES).flat());
  for (const k of ['messybed', 'dirtymattress', 'dirtytoilet', 'dirtysink', 'towelfloor', 'fridgeempty']) {
    assert.ok(inAFamily.has(k), `fault asset "${k}" is in no family`);
  }
});

test('every family member has a human-readable label', () => {
  // The swap buttons show these. Falling back to the raw key gives a teacher
  // "dirtymatress" — a filename, complete with its typo.
  for (const k of Object.values(FAMILIES).flat()) {
    const l = labelFor(k);
    assert.ok(l && l !== k, `"${k}" has no label`);
  }
});

test('labelFor falls back to the key rather than throwing on an unknown model', () => {
  assert.equal(labelFor('wardrobe'), 'wardrobe');
  assert.equal(labelFor(undefined), '');
});
