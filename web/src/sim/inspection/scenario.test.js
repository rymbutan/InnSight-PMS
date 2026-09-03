import test from 'node:test';
import assert from 'node:assert';

import { fromScenario, pickScenario } from './scenario.js';
import { scoreInspection } from './inspectionScore.js';
import { GOOD } from '../taskScore.js';
import { localDay } from '../../lib/date.js';
import { setCustomCategories } from './categories.js';

function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const scenario = (over = {}) => ({
  id: 'sc1',
  name: 'Couple in a twin room',
  roomTier: 'Standard',
  active: true,
  booking: { guestName: 'Dela Cruz, Maria', adults: 2, children: 0, specialRequests: 'Honeymoon.' },
  furniture: [
    { model: 'twin', pos: [-1, -2], ry: 0 },
    { model: 'twin', pos: [1, -2], ry: 0 },
  ],
  anchors: [
    { id: 'a1', label: 'Beds', defectId: 'room_mismatch', pos: [0, -2], size: [2, 1, 2] },
    { id: 'c1', label: 'Wardrobe', defectId: null, pos: [-2, 1], size: [1, 1, 1] },
  ],
  ...over,
});

// ── the clipboard booking ──
//
// The room is only wrong RELATIVE TO A BOOKING, and on a real room that booking
// is the reservation the guest actually made. A scenario authors what is wrong
// with the room; it does not author who is arriving. These tests are what stops
// the authored-booking field growing back — it did once, and the clipboard then
// showed a guest nobody had booked.

const reservation = (over = {}) => ({
  confirmationNumber: 'R-REAL0001',
  guestName: 'Santos, Paolo',
  adults: 3,
  children: 1,
  nights: 4,
  checkIn: '2027-03-14T06:00:00.000Z',
  specialRequests: 'Cot for the youngest.',
  ...over,
});

test('the clipboard booking is the room real reservation', () => {
  const { caseFile } = fromScenario(scenario(), { rng: seeded(1), reservation: reservation() });
  assert.equal(caseFile.guestName, 'Santos, Paolo');
  assert.equal(caseFile.confirmationNumber, 'R-REAL0001');
  assert.equal(caseFile.adults, 3);
  assert.equal(caseFile.children, 1);
  assert.equal(caseFile.pax, 4);
  assert.equal(caseFile.specialRequests, 'Cot for the youngest.');
  assert.equal(caseFile.fromReservation, true);
});

test('an authored booking never reaches the clipboard', () => {
  // Old rows still carry one in a nullable column. It must be inert: a student
  // inspecting a real room is judging it against the real guest, and a scenario
  // reused across two rooms cannot possibly know either of their bookings.
  const { caseFile } = fromScenario(scenario(), { rng: seeded(1), reservation: reservation() });
  assert.notEqual(caseFile.guestName, 'Dela Cruz, Maria');
  assert.notEqual(caseFile.specialRequests, 'Honeymoon.');
});

test('the real arrival date and length of stay reach the clipboard', () => {
  const { caseFile } = fromScenario(scenario(), { rng: seeded(1), reservation: reservation() });
  assert.equal(caseFile.arrival, localDay('2027-03-14T06:00:00.000Z'));
  assert.equal(caseFile.nights, 4);
});

test('no reservation falls back to a synthetic practice booking', () => {
  // Training practice drills have no room and so no reservation. They still need
  // a booking to inspect against — flagged, so the clipboard can say so.
  const { caseFile } = fromScenario(scenario(), { rng: seeded(1) });
  assert.equal(caseFile.fromReservation, false);
  assert.ok(caseFile.guestName && caseFile.guestName !== '\u2014', 'needs a readable guest name');
  assert.ok(caseFile.adults >= 1);
  assert.equal(caseFile.pax, caseFile.adults + caseFile.children);
});

test('an authored fault the real booking cannot support becomes a decoy', () => {
  // room_mismatch is "twin beds for a couple". Hand the same authored room to a
  // solo guest and the twins are not a fault at all — grading it would mark a
  // student wrong for signing off a correct room. The anchor stays (the object is
  // still there to look at); only its fault status goes.
  const { caseFile, anchors } = fromScenario(scenario(), {
    rng: seeded(1),
    reservation: reservation({ adults: 1, children: 0 }),
  });
  assert.equal(caseFile.pax, 1);
  assert.ok(!caseFile.injected.includes('room_mismatch'));
  assert.equal(anchors.length, 2, 'the object is still there to inspect');
  assert.equal(
    anchors.find((a) => a.id === 'a1').defectId,
    null,
    'the unsupportable fault is demoted, not deleted'
  );
});

test('the same authored fault stands when the real booking does support it', () => {
  const { caseFile, anchors } = fromScenario(scenario(), {
    rng: seeded(1),
    reservation: reservation({ adults: 2, children: 0 }),
  });
  assert.deepEqual(caseFile.injected, ['room_mismatch']);
  assert.equal(anchors.find((a) => a.id === 'a1').defectId, 'room_mismatch');
});

test('a practice booking is invented to fit the authored faults', () => {
  // No reservation, so the booking is ours to choose — and the drill must not be
  // silently defused by it. The generated path draws the party first and then
  // only the faults it supports; here the faults come first, so the party bends
  // to them. Without this a practice drill nulls out an authored room_mismatch
  // every time it happens to draw a solo guest.
  for (const seed of [1, 2, 3, 7, 11, 42]) {
    const { caseFile, anchors } = fromScenario(scenario(), { rng: seeded(seed) });
    assert.equal(caseFile.fromReservation, false);
    assert.deepEqual(caseFile.injected, ['room_mismatch'], `seed ${seed} defused the drill`);
    assert.equal(anchors.find((a) => a.id === 'a1').defectId, 'room_mismatch');
    assert.equal(caseFile.pax, 2);
    assert.equal(caseFile.children, 0);
  }
});

test('a teacher-authored category is never demoted by the booking', () => {
  // Custom categories carry no appliesTo — nothing about a booking can rule out
  // "a rat behind the wardrobe", and silently demoting one would make every
  // custom fault ungradeable on a solo stay.
  setCustomCategories([{ id: 'custom_pest', label: 'Pest', why: 'Rats.', active: true }]);
  const s = scenario({
    anchors: [{ id: 'p1', label: 'Wardrobe', defectId: 'custom_pest', pos: [0, 0] }],
  });
  const { caseFile, anchors } = fromScenario(s, {
    rng: seeded(1),
    reservation: reservation({ adults: 1, children: 0 }),
  });
  assert.deepEqual(caseFile.injected, ['custom_pest']);
  assert.equal(anchors[0].defectId, 'custom_pest');
  setCustomCategories([]);
});

test('the room tier still comes from the scenario, not the reservation', () => {
  const { caseFile } = fromScenario(scenario({ roomTier: 'Suite' }), {
    rng: seeded(1),
    reservation: reservation({ roomTypeCode: 'STD' }),
  });
  assert.equal(caseFile.roomTier, 'Suite');
});

test('derives the graded defect list from the tagged anchors', () => {
  const { caseFile } = fromScenario(scenario(), { rng: seeded(1) });
  assert.deepEqual(caseFile.injected, ['room_mismatch']);
});

test('generates a fresh confirmation number per run, and never stores one', () => {
  const a = fromScenario(scenario(), { rng: seeded(1) }).caseFile.confirmationNumber;
  const b = fromScenario(scenario(), { rng: seeded(2) }).caseFile.confirmationNumber;
  assert.match(a, /^R-[0-9A-F]{8}$/);
  assert.notEqual(a, b);
});

test('passes the authored furniture through as the room', () => {
  const { layout } = fromScenario(scenario(), { rng: seeded(1) });
  assert.equal(layout.furniture.length, 2);
  assert.equal(layout.furniture.filter((f) => f.model === 'twin').length, 2);
});

test('keeps clean decoys as anchors so they can be correctly signed off', () => {
  const { anchors } = fromScenario(scenario(), { rng: seeded(1) });
  assert.equal(anchors.length, 2);
  assert.equal(anchors.filter((a) => a.defectId === null).length, 1);
});

test('demotes an unknown category to a decoy rather than an ungradeable fault', () => {
  // A fault the flag menu cannot offer could never be matched, so the run would
  // be unwinnable with nothing in the UI to explain why.
  const s = scenario({
    anchors: [{ id: 'x', label: 'Thing', defectId: 'not_a_real_category', pos: [0, 0] }],
  });
  const { caseFile, anchors } = fromScenario(s, { rng: seeded(1) });
  assert.deepEqual(caseFile.injected, []);
  assert.equal(anchors[0].defectId, null);
});

test('a scenario with no faults still produces a valid, gradeable case', () => {
  const s = scenario({ anchors: [{ id: 'c1', label: 'Wardrobe', defectId: null, pos: [0, 0] }] });
  const { caseFile } = fromScenario(s, { rng: seeded(1) });
  assert.deepEqual(caseFile.injected, []);
  const items = scoreInspection({ caseFile, flags: [], elapsedSec: 10 });
  assert.equal(items.length, 1); // precision only
});

test('an authored case grades through the same path as a generated one', () => {
  const { caseFile, anchors } = fromScenario(scenario(), { rng: seeded(1) });
  const found = anchors.find((a) => a.defectId === 'room_mismatch');
  const items = scoreInspection({
    caseFile,
    flags: [{ anchorId: found.id, defectId: found.defectId, chosenCategory: 'room_mismatch' }],
    elapsedSec: 60,
  });
  const it = items.find((i) => i.key === 'room_mismatch');
  assert.equal(it.procedure, GOOD);
  assert.equal(it.understanding, GOOD);
});

test('duplicate tags collapse to one graded item per category', () => {
  const s = scenario({
    anchors: [
      { id: 'a1', label: 'Vacuum', defectId: 'lingering_equipment', pos: [0, 0] },
      { id: 'a2', label: 'Bucket', defectId: 'lingering_equipment', pos: [1, 0] },
    ],
  });
  const { caseFile } = fromScenario(s, { rng: seeded(1) });
  assert.deepEqual(caseFile.injected, ['lingering_equipment']);
});

// ── pickScenario ──

test('picks only active scenarios matching the tier', () => {
  const list = [
    scenario({ id: 'a', roomTier: 'Suite' }),
    scenario({ id: 'b', active: false }),
    scenario({ id: 'c' }),
  ];
  for (let i = 1; i < 12; i += 1) {
    const got = pickScenario(list, 'Standard', seeded(i));
    assert.equal(got.id, 'c');
  }
});

test('returns null when nothing is authored, so the sim falls back to generation', () => {
  assert.equal(pickScenario([], 'Standard', seeded(1)), null);
  assert.equal(pickScenario(null, 'Standard', seeded(1)), null);
  assert.equal(pickScenario([scenario({ roomTier: 'Deluxe' })], 'Standard', seeded(1)), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios track the LIVE tier layout.
//
// They used to store only `furniture` and `anchors`, and fromScenario built the
// room as `{ ...scenario.baseLayout, furniture }` — but nothing ever wrote
// baseLayout. So every authored scenario rendered with w, l, h, floor, spawn and
// walls all `undefined`: no bathroom walls, and RoomShell sizing its shadow
// frustum from Math.max(undefined, undefined). The room a teacher authored was
// never the room a student walked into.
// ─────────────────────────────────────────────────────────────────────────────

import { refOf } from './scenario.js';

const plan = () => ({
  tier: 'Standard',
  w: 6.4,
  l: 8,
  h: 3,
  floor: '#5a3d28',
  spawn: [0, 3.2],
  walls: [{ p: [1, 0], w: 3, d: 0.16 }],
  furniture: [
    { model: 'bed', pos: [0, -3.4], ry: 0, box: [1.95, 2.05] },
    { model: 'toilet', pos: [2.9, 1.9], ry: 0 },
    { type: 'drape', pos: [0, -3.96], s: [6, 2.7] },
  ],
});

test('the room shell comes from the live tier layout, not from the scenario', () => {
  const { layout } = fromScenario({ roomTier: 'Standard', booking: {} }, { rng: seeded(1), plan: plan() });
  assert.equal(layout.w, 6.4);
  assert.equal(layout.l, 8);
  assert.equal(layout.h, 3);
  assert.equal(layout.floor, '#5a3d28');
  assert.deepEqual(layout.spawn, [0, 3.2]);
  assert.equal(layout.walls.length, 1, 'the bathroom walls must survive');
});

test('base furniture comes from the live tier, so layout edits flow through', () => {
  const { layout } = fromScenario({ roomTier: 'Standard', booking: {} }, { rng: seeded(1), plan: plan() });
  assert.deepEqual(
    layout.furniture.map((f) => f.model || f.type),
    ['bed', 'toilet', 'drape']
  );
});

test('a swap changes only the asset, never its placement', () => {
  const p = plan();
  const s = {
    roomTier: 'Standard',
    booking: {},
    swaps: { [refOf(p.furniture[0])]: 'messybed' },
  };
  const { layout } = fromScenario(s, { rng: seeded(1), plan: p });
  const bed = layout.furniture[0];
  assert.equal(bed.model, 'messybed', 'the asset changed');
  assert.deepEqual(bed.pos, [0, -3.4], 'the position did not');
  assert.equal(bed.ry, 0);
  assert.deepEqual(bed.box, [1.95, 2.05]);
});

test('a swap naming an unknown fixture is ignored rather than corrupting the room', () => {
  const s = { roomTier: 'Standard', booking: {}, swaps: { 'sofa@9,9': 'messybed' } };
  const { layout } = fromScenario(s, { rng: seeded(1), plan: plan() });
  assert.equal(layout.furniture.length, 3);
  assert.equal(layout.furniture[0].model, 'bed');
});

test('objects the teacher added are appended to the tier furniture', () => {
  const s = {
    roomTier: 'Standard',
    booking: {},
    added: [{ id: 'a1', model: 'cleaningcart', pos: [1, 1], ry: 0 }],
  };
  const { layout } = fromScenario(s, { rng: seeded(1), plan: plan() });
  assert.equal(layout.furniture.length, 4);
  assert.equal(layout.furniture[3].model, 'cleaningcart');
});

test('tags become the graded anchors, on base fixtures and added objects alike', () => {
  const p = plan();
  const s = {
    roomTier: 'Standard',
    booking: {},
    added: [{ id: 'a1', model: 'cleaningcart', pos: [1, 1] }],
    tags: [
      { ref: refOf(p.furniture[1]), defectId: 'lived_in', label: 'Toilet' },
      { ref: 'a1', defectId: 'lingering_equipment', label: 'Cleaning cart' },
      { ref: refOf(p.furniture[0]), defectId: null, label: 'Bed' },
    ],
  };
  const { anchors, caseFile } = fromScenario(s, { rng: seeded(1), plan: p });
  assert.equal(anchors.length, 3);
  assert.deepEqual(caseFile.injected.sort(), ['lingering_equipment', 'lived_in']);
  const decoy = anchors.find((a) => a.label === 'Bed');
  assert.equal(decoy.defectId, null, 'a clean decoy stays clickable but ungraded');
});

test('an anchor sits where its fixture actually is', () => {
  const p = plan();
  const s = {
    roomTier: 'Standard',
    booking: {},
    tags: [{ ref: refOf(p.furniture[1]), defectId: 'lived_in' }],
  };
  const { anchors } = fromScenario(s, { rng: seeded(1), plan: p });
  assert.deepEqual(anchors[0].pos, [2.9, 1.9]);
});

test('a legacy row storing furniture still renders, and gains the missing shell', () => {
  // Rows written before this change have `furniture` and `anchors` and no swaps.
  // They must keep working — and pick up the walls and dimensions they never had.
  const legacy = {
    roomTier: 'Standard',
    booking: {},
    furniture: [{ model: 'bed', pos: [0, -3.4] }],
    anchors: [{ id: 'd1', defectId: 'lived_in', label: 'Bed', pos: [0, -3.4], size: [2, 1, 2] }],
  };
  const { layout, anchors, caseFile } = fromScenario(legacy, { rng: seeded(1), plan: plan() });
  assert.equal(layout.w, 6.4, 'the shell is filled in from the tier');
  assert.equal(layout.walls.length, 1);
  assert.deepEqual(
    layout.furniture.map((f) => f.model),
    ['bed'],
    'the authored snapshot still wins for a legacy row'
  );
  assert.equal(anchors.length, 1);
  assert.deepEqual(caseFile.injected, ['lived_in']);
});

test('a swap can also carry a rotation, so a fixture can be re-oriented', () => {
  // Rotation is the one placement property a scenario may set: an added prop or a
  // swapped-in asset often needs turning to face the room. Position is NOT
  // settable — that is what keeps a scenario from rearranging the layout.
  const p = plan();
  const s = {
    roomTier: 'Standard',
    booking: {},
    swaps: { [refOf(p.furniture[0])]: { model: 'messybed', ry: Math.PI / 2 } },
  };
  const { layout } = fromScenario(s, { rng: seeded(1), plan: p });
  assert.equal(layout.furniture[0].model, 'messybed');
  assert.equal(layout.furniture[0].ry, Math.PI / 2);
  assert.deepEqual(layout.furniture[0].pos, [0, -3.4], 'still cannot move it');
});

test('a rotation-only override leaves the asset alone', () => {
  const p = plan();
  const s = { roomTier: 'Standard', booking: {}, swaps: { [refOf(p.furniture[1])]: { ry: 1.2 } } };
  const { layout } = fromScenario(s, { rng: seeded(1), plan: p });
  assert.equal(layout.furniture[1].model, 'toilet');
  assert.equal(layout.furniture[1].ry, 1.2);
});

test('a swap can carry a uniform scale, so a fixture can be resized', () => {
  const p = plan();
  const s = {
    roomTier: 'Standard',
    booking: {},
    swaps: { [refOf(p.furniture[0])]: { scale: [1.5, 1.5, 1.5] } },
  };
  const { layout } = fromScenario(s, { rng: seeded(1), plan: p });
  assert.deepEqual(layout.furniture[0].scale, [1.5, 1.5, 1.5]);
  assert.equal(layout.furniture[0].model, 'bed', 'the asset is untouched');
  assert.deepEqual(layout.furniture[0].pos, [0, -3.4], 'and it still cannot move');
});

test('asset, facing and size can be overridden together', () => {
  const p = plan();
  const s = {
    roomTier: 'Standard',
    booking: {},
    swaps: { [refOf(p.furniture[0])]: { model: 'messybed', ry: 0.5, scale: [0.8, 0.8, 0.8] } },
  };
  const { layout } = fromScenario(s, { rng: seeded(1), plan: p });
  const bed = layout.furniture[0];
  assert.equal(bed.model, 'messybed');
  assert.equal(bed.ry, 0.5);
  assert.deepEqual(bed.scale, [0.8, 0.8, 0.8]);
});

test('an added object keeps the scale it was authored with', () => {
  const s = {
    roomTier: 'Standard',
    booking: {},
    added: [{ id: 'a1', model: 'cleaningcart', pos: [1, 1], scale: [2, 2, 2] }],
  };
  const { layout } = fromScenario(s, { rng: seeded(1), plan: plan() });
  assert.deepEqual(layout.furniture[3].scale, [2, 2, 2]);
});

test('a swap can carry a height, so a fixture can be raised off the floor', () => {
  // itemY() already honours `y` for models — what was missing was any way to
  // author it: the gizmo showed no Y arrow for a model and commitGizmo threw the
  // height away on mouse-up.
  const p = plan();
  const s = { roomTier: 'Standard', booking: {}, swaps: { [refOf(p.furniture[1])]: { y: 1.2 } } };
  const { layout } = fromScenario(s, { rng: seeded(1), plan: p });
  assert.equal(layout.furniture[1].y, 1.2);
  assert.equal(layout.furniture[1].model, 'toilet', 'the asset is untouched');
  assert.deepEqual(layout.furniture[1].pos, [2.9, 1.9], 'and the floor position is untouched');
});

test('height, facing, size and asset can all be overridden at once', () => {
  const p = plan();
  const s = {
    roomTier: 'Standard',
    booking: {},
    swaps: { [refOf(p.furniture[0])]: { model: 'messybed', ry: 0.5, scale: [1.2, 1.2, 1.2], y: 0.4 } },
  };
  const { layout } = fromScenario(s, { rng: seeded(1), plan: p });
  const b = layout.furniture[0];
  assert.equal(b.model, 'messybed');
  assert.equal(b.ry, 0.5);
  assert.deepEqual(b.scale, [1.2, 1.2, 1.2]);
  assert.equal(b.y, 0.4);
});

test('a height of zero is honoured, not treated as unset', () => {
  // A wall-mounted fixture pulled down to the floor must stay there; `y: 0` is a
  // real value and a falsy-check would silently discard it.
  const p = plan();
  p.furniture[1].y = 1.4;
  const s = { roomTier: 'Standard', booking: {}, swaps: { [refOf(p.furniture[1])]: { y: 0 } } };
  const { layout } = fromScenario(s, { rng: seeded(1), plan: p });
  assert.equal(layout.furniture[1].y, 0);
});

// ── Save-time counts ────────────────────────────────────────────────────────
// The editor blocks a save with no faults ("there is nothing to find") and warns
// on one with no decoys. That check read `payload.anchors` — which went empty the
// moment scenarios switched to the tags overlay, so EVERY save was refused. The
// count lives here now, where both shapes are covered by tests.

import { scenarioCounts } from './scenario.js';

test('counts faults and decoys from the tags overlay', () => {
  const c = scenarioCounts({
    tags: [
      { ref: 'a', defectId: 'lived_in' },
      { ref: 'b', defectId: 'blocked_path' },
      { ref: 'c', defectId: null },
    ],
    anchors: [],
  });
  assert.deepEqual(c, { faults: 2, decoys: 1 });
});

test('counts a legacy payload that still uses anchors', () => {
  const c = scenarioCounts({
    anchors: [{ defectId: 'lived_in' }, { defectId: null }],
  });
  assert.deepEqual(c, { faults: 1, decoys: 1 });
});

test('an empty payload counts nothing rather than throwing', () => {
  assert.deepEqual(scenarioCounts({}), { faults: 0, decoys: 0 });
  assert.deepEqual(scenarioCounts(null), { faults: 0, decoys: 0 });
});

test('tags win over an empty anchors array — the regression that blocked saving', () => {
  const c = scenarioCounts({ tags: [{ ref: 'a', defectId: 'lived_in' }], anchors: [] });
  assert.equal(c.faults, 1, 'an empty anchors array must not mask the tags');
});

test('a tag survives its fixture being swapped to another asset', () => {
  // THE common authoring move: swap the bed to the messy one, then tag it
  // "room still looks used". The ref index was built from the POST-swap
  // furniture, so the bed's ref became messybed@… and the tag bed@… matched
  // nothing — the fault silently disappeared from the graded list.
  const p = plan();
  const ref = refOf(p.furniture[0]); // bed@0,-3.4
  const s = {
    roomTier: 'Standard',
    booking: {},
    swaps: { [ref]: { model: 'messybed' } },
    tags: [{ ref, defectId: 'lived_in', label: 'Bed' }],
  };
  const { anchors, caseFile } = fromScenario(s, { rng: seeded(1), plan: p });
  assert.deepEqual(caseFile.injected, ['lived_in'], 'the fault must still be graded');
  assert.equal(anchors.length, 1);
  assert.deepEqual(anchors[0].pos, [0, -3.4], 'and anchored on the swapped fixture');
});

test('refs stay addressable by the ORIGINAL asset after any override', () => {
  const p = plan();
  const ref = refOf(p.furniture[1]); // toilet@2.9,1.9
  const s = {
    roomTier: 'Standard',
    booking: {},
    swaps: { [ref]: { model: 'dirtytoilet', ry: 1, scale: [1.2, 1.2, 1.2], y: 0.1 } },
    tags: [{ ref, defectId: 'lived_in' }],
  };
  const { anchors } = fromScenario(s, { rng: seeded(1), plan: p });
  assert.equal(anchors.length, 1, 'a fully overridden fixture is still taggable');
});
