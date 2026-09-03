import test from 'node:test';
import assert from 'node:assert';

import { GOOD, ISSUES } from '../taskScore.js';
import { scoreInspection } from './inspectionScore.js';

const c = { injected: ['room_mismatch', 'amenity_math'], roomTier: 'Standard', pax: 4 };
const itemFor = (items, key) => items.find((i) => i.key === key);

test('a correctly found and correctly categorised defect scores both halves', () => {
  const items = scoreInspection({
    caseFile: c,
    flags: [{ anchorId: 'a1', defectId: 'room_mismatch', chosenCategory: 'room_mismatch' }],
    elapsedSec: 60,
  });
  const it = itemFor(items, 'room_mismatch');
  assert.equal(it.procedure, GOOD);
  assert.equal(it.understanding, GOOD);
});

test('found but miscategorised scores the Did, fails the Why, and returns feedback', () => {
  const items = scoreInspection({
    caseFile: c,
    flags: [{ anchorId: 'a1', defectId: 'room_mismatch', chosenCategory: 'lived_in' }],
    elapsedSec: 60,
  });
  const it = itemFor(items, 'room_mismatch');
  assert.equal(it.procedure, GOOD);
  assert.equal(it.understanding, ISSUES);
  assert.ok(it.feedback && it.feedback.length > 0);
});

test('a missed defect fails the Did and has no Why to judge', () => {
  const items = scoreInspection({ caseFile: c, flags: [], elapsedSec: 60 });
  assert.equal(itemFor(items, 'amenity_math').procedure, ISSUES);
  assert.equal(itemFor(items, 'amenity_math').understanding, null);
});

test('signing off a faulty item as correct is a miss, and is called out as worse', () => {
  const items = scoreInspection({
    caseFile: c,
    flags: [{ anchorId: 'a1', defectId: 'room_mismatch', chosenCategory: 'ok' }],
    elapsedSec: 60,
  });
  const it = itemFor(items, 'room_mismatch');
  assert.equal(it.procedure, ISSUES);
  assert.match(it.note, /marked it correct/i);
});

test('there is one item per injected defect, plus a precision item', () => {
  const items = scoreInspection({ caseFile: c, flags: [], elapsedSec: 60 });
  assert.equal(items.length, c.injected.length + 1);
  assert.ok(itemFor(items, 'precision'));
});

test('a clean room flagged as faulty is a false positive and costs precision', () => {
  const clean = scoreInspection({ caseFile: c, flags: [], elapsedSec: 60 });
  assert.equal(itemFor(clean, 'precision').procedure, GOOD);

  const sloppy = scoreInspection({
    caseFile: c,
    flags: [{ anchorId: 'x', defectId: null, chosenCategory: 'lived_in' }],
    elapsedSec: 60,
  });
  assert.equal(itemFor(sloppy, 'precision').procedure, ISSUES);
});

test('marking a clean object as correct is not a false positive', () => {
  const items = scoreInspection({
    caseFile: c,
    flags: [{ anchorId: 'x', defectId: null, chosenCategory: 'ok' }],
    elapsedSec: 60,
  });
  assert.equal(itemFor(items, 'precision').procedure, GOOD);
});

test('flagging everything does not pass — the degenerate strategy must fail', () => {
  // Both real defects found AND correctly named, but six clean objects condemned.
  const flags = [
    { anchorId: 'a1', defectId: 'room_mismatch', chosenCategory: 'room_mismatch' },
    { anchorId: 'a2', defectId: 'amenity_math', chosenCategory: 'amenity_math' },
    ...Array.from({ length: 6 }, (_, i) => ({
      anchorId: `c${i}`,
      defectId: null,
      chosenCategory: 'lived_in',
    })),
  ];
  const items = scoreInspection({ caseFile: c, flags, elapsedSec: 60 });
  assert.notEqual(itemFor(items, 'precision').procedure, GOOD);
});

test('a perfect run scores every dimension GOOD', () => {
  const items = scoreInspection({
    caseFile: c,
    flags: [
      { anchorId: 'a1', defectId: 'room_mismatch', chosenCategory: 'room_mismatch' },
      { anchorId: 'a2', defectId: 'amenity_math', chosenCategory: 'amenity_math' },
      { anchorId: 'c1', defectId: null, chosenCategory: 'ok' },
    ],
    elapsedSec: 90,
  });
  for (const it of items) {
    assert.equal(it.procedure, GOOD, `${it.key} procedure`);
    assert.equal(it.understanding, GOOD, `${it.key} understanding`);
  }
});

test('every item carries the label and note the assessment renders', () => {
  const items = scoreInspection({ caseFile: c, flags: [], elapsedSec: 10 });
  for (const it of items) {
    assert.ok(it.key, 'key');
    assert.ok(it.label && it.label.length > 0, `${it.key} label`);
    assert.ok(it.note && it.note.length > 0, `${it.key} note`);
  }
});

test('a case with no injected defects still returns a precision item', () => {
  const items = scoreInspection({ caseFile: { injected: [] }, flags: [], elapsedSec: 5 });
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'precision');
});
