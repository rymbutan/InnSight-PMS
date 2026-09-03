import test from 'node:test';
import assert from 'node:assert';
import {
  BUILTIN_CATEGORIES,
  allCategories,
  offerableCategories,
  categoryById,
  isKnownCategory,
  isCustomCategoryId,
  setCustomCategories,
} from './categories.js';
import { fromScenario } from './scenario.js';
import { scoreInspection } from './inspectionScore.js';

// These pin the three bugs that made teacher-authored categories unusable:
//   1. nothing registered them, so they could not be saved or offered
//   2. fromScenario demoted them to decoys
//   3. scoreInspection could not resolve them, so the fault was never graded

const PEST = {
  id: 'custom_pest',
  label: 'Pest or sanitation hazard',
  why: 'A rat in a guest room is a health violation, not untidiness.',
  feedback: 'Escalate immediately; the room cannot be released.',
  active: true,
};

const reset = () => setCustomCategories([]);

test('the six built-ins are always present, with an explanation each', () => {
  reset();
  assert.equal(BUILTIN_CATEGORIES.length, 6);
  for (const c of BUILTIN_CATEGORIES) {
    assert.ok(c.label, `${c.id} label`);
    assert.ok(c.title, `${c.id} title`);
    assert.ok(c.why, `${c.id} why`);
  }
});

test('a custom id is recognised, a built-in or junk id is not', () => {
  assert.equal(isCustomCategoryId('custom_pest'), true);
  assert.equal(isCustomCategoryId('custom_two_words'), true);
  assert.equal(isCustomCategoryId('lived_in'), false);
  assert.equal(isCustomCategoryId('custom_'), false);
  assert.equal(isCustomCategoryId('Custom_Pest'), false);
});

test('a registered custom category is offerable and resolvable everywhere', () => {
  reset();
  setCustomCategories([PEST]);
  assert.equal(allCategories().length, 7);
  assert.equal(offerableCategories().length, 7);
  assert.equal(categoryById('custom_pest').why, PEST.why);
  assert.equal(isKnownCategory('custom_pest'), true);
  reset();
});

test('a retired category still resolves but is no longer offered', () => {
  reset();
  // A scenario saved earlier may tag a fixture with it; dropping it would make
  // that fault unwinnable, so it must still grade.
  setCustomCategories([{ ...PEST, active: false }]);
  assert.equal(
    offerableCategories().some((c) => c.id === 'custom_pest'),
    false
  );
  assert.equal(categoryById('custom_pest').why, PEST.why);
  reset();
});

test('a category with no "why" is refused registration', () => {
  reset();
  // It would mark a student wrong with a blank reason.
  setCustomCategories([{ id: 'custom_nowhy', label: 'No reason', why: '  ' }]);
  assert.equal(categoryById('custom_nowhy'), null);
});

test('data can never shadow a built-in category', () => {
  reset();
  setCustomCategories([{ id: 'lived_in', label: 'Hijacked', why: 'nope' }]);
  assert.equal(categoryById('lived_in').label, BUILTIN_CATEGORIES.find((c) => c.id === 'lived_in').label);
  reset();
});

test('a scenario tagged with a custom category keeps it and grades it', () => {
  reset();
  setCustomCategories([PEST]);

  const scenario = {
    roomTier: 'Standard',
    furniture: [],
    tags: [{ ref: 'bed@1.6,-1.3', defectId: 'custom_pest', label: 'Bed' }],
  };
  const built = fromScenario(scenario);

  // (2) survives instead of being demoted to a decoy…
  const anchor = built.anchors.find((a) => a.defectId === 'custom_pest');
  assert.ok(anchor, 'the custom-category anchor must survive fromScenario');
  // …and reaches the case file, or nothing would ever be scored.
  assert.ok(built.caseFile.injected.includes('custom_pest'), 'must appear in injected');

  // (3) and grades, with the teacher's own explanation.
  const items = scoreInspection({
    caseFile: built.caseFile,
    flags: [{ anchorId: anchor.id, defectId: 'custom_pest', chosenCategory: 'custom_pest' }],
    elapsedSec: 30,
  });
  const item = items.find((i) => i.key === 'custom_pest');
  assert.ok(item, 'the custom fault must produce an assessment item');
  assert.equal(item.label, PEST.label);
  assert.equal(item.note, PEST.why);
  reset();
});

test('an unregistered custom id is still demoted to a decoy', () => {
  reset();
  // Nothing can explain it, so it must not become an unwinnable fault.
  const built = fromScenario({
    roomTier: 'Standard',
    furniture: [],
    tags: [{ ref: 'bed@1.6,-1.3', defectId: 'custom_never_made', label: 'Bed' }],
  });
  assert.equal(
    built.anchors.every((a) => a.defectId !== 'custom_never_made'),
    true
  );
  assert.equal(built.caseFile.injected.includes('custom_never_made'), false);
});
