import test from 'node:test';
import assert from 'node:assert';

import { DEFECTS, applyDefects } from './defects.js';
import { BUILTIN_CATEGORIES } from './categories.js';

const baseCase = (over = {}) => ({
  confirmationNumber: 'R-TEST',
  guestName: 'Test Guest',
  adults: 2,
  children: 0,
  pax: 2,
  roomTier: 'Standard',
  nights: 2,
  arrival: '2027-01-01',
  specialRequests: null,
  injected: [],
  ...over,
});

const layout = () => ({
  w: 6,
  l: 8,
  furniture: [
    { model: 'bed', pos: [0, -2], ry: 0 },
    { model: 'sofa', pos: [-2, 1], ry: 0 },
    { model: 'towelrack', pos: [2, 3], ry: 0, y: 1.3 },
    { model: 'towelstack', pos: [2.1, 3], ry: 0 },
    { model: 'minibar', pos: [2, -1], ry: 0 },
    { model: 'vanity', pos: [1.9, 2.4], ry: 0 },
    { model: 'wardrobe', pos: [-2.5, -2], ry: 0 },
    { model: 'tv', pos: [0, 2.8], ry: 0 },
  ],
});

test('there are exactly six defect categories, matching the change request', () => {
  assert.equal(DEFECTS.length, 6);
  assert.deepEqual(DEFECTS.map((d) => d.id).sort(), [
    'amenity_math',
    'blocked_path',
    'incomplete_stock',
    'lingering_equipment',
    'lived_in',
    'room_mismatch',
  ]);
});

test('every defect carries the fields the UI and rubric need', () => {
  for (const d of DEFECTS) {
    assert.ok(d.title && typeof d.title === 'string', `${d.id} title`);
    assert.ok(d.why && typeof d.why === 'string', `${d.id} why`);
    assert.ok(d.feedback && typeof d.feedback === 'string', `${d.id} feedback`);
    assert.equal(typeof d.appliesTo, 'function', `${d.id} appliesTo`);
    assert.equal(typeof d.apply, 'function', `${d.id} apply`);
    assert.equal(typeof d.anchorAt, 'function', `${d.id} anchorAt`);
  }
});

test('the flag menu offers every defect category', () => {
  for (const d of DEFECTS) {
    assert.ok(
      BUILTIN_CATEGORIES.some((o) => o.id === d.id),
      `${d.id} missing from menu`
    );
  }
});

test('amenity math needs BOTH a big enough party and a towel rack to hang it on', () => {
  const d = DEFECTS.find((x) => x.id === 'amenity_math');

  // A small party can never be short-changed, whatever the room holds.
  for (const tier of TIERS) {
    assert.equal(d.appliesTo(baseCase({ roomTier: tier, adults: 1, children: 0, pax: 1 })), false);
    assert.equal(d.appliesTo(baseCase({ roomTier: tier, adults: 2, children: 0, pax: 2 })), false);
  }

  // The second condition is the anchor. Every tier is now an author-made layout,
  // and NONE of them contains a towelrack — so this fault currently cannot fire
  // anywhere, and the guard in defects.js is what stops a student being marked on
  // a fault that was never rendered. Add a `towelrack` to a tier and it returns.
  const anchored = TIERS.filter((tier) =>
    LAYOUTS[tier].furniture.some((f) => f.model === 'towelrack' || f.model === 'towel')
  );
  for (const tier of TIERS) {
    assert.equal(
      d.appliesTo(baseCase({ roomTier: tier, adults: 2, children: 2, pax: 4 })),
      anchored.includes(tier),
      `${tier}: appliesTo must track whether the tier owns a towel rack`
    );
  }
});

test('room mismatch needs a couple — the bed setup is only wrong relative to the booking', () => {
  const d = DEFECTS.find((x) => x.id === 'room_mismatch');
  assert.equal(d.appliesTo(baseCase({ adults: 2, children: 0, pax: 2 })), true);
  assert.equal(d.appliesTo(baseCase({ adults: 1, children: 0, pax: 1 })), false);
  assert.equal(d.appliesTo(baseCase({ adults: 2, children: 2, pax: 4 })), false);
});

test('applying a defect mutates the layout and never mutates the input', () => {
  const original = layout();
  const snapshot = JSON.stringify(original);
  const c = baseCase({ injected: ['room_mismatch'] });
  const out = applyDefects(original, c);
  assert.equal(JSON.stringify(original), snapshot, 'input layout was mutated');
  assert.notEqual(JSON.stringify(out.layout.furniture), JSON.stringify(original.furniture));
});

test('room mismatch replaces the single bed with two twins', () => {
  const c = baseCase({ injected: ['room_mismatch'] });
  const out = applyDefects(layout(), c);
  const beds = out.layout.furniture.filter((f) => f.model === 'twin');
  assert.equal(beds.length, 2);
  assert.equal(
    out.layout.furniture.some((f) => f.model === 'bed'),
    false
  );
});

test('amenity math leaves fewer towels than a party of four needs', () => {
  const c = baseCase({ adults: 2, children: 2, pax: 4, injected: ['amenity_math'] });
  const out = applyDefects(layout(), c);
  assert.equal(
    out.layout.furniture.some((f) => f.model === 'towelstack'),
    false,
    'the towel stack should be gone'
  );
});

test('blocked path leaves an obstruction in the walkway without moving furniture', () => {
  // This test used to assert the opposite — that the sofa was dragged into the
  // through-route. That behaviour was removed on purpose: a scenario must not
  // rearrange the room the teacher laid out, and a solid fixture in the walkway
  // can wedge a student against real geometry. The obstruction is a `prim`, so
  // it reads as blocking the route while remaining walk-through.
  const before = layout().furniture.find((f) => f.model === 'sofa').pos;
  const c = baseCase({ injected: ['blocked_path'] });
  const out = applyDefects(layout(), c);
  const after = out.layout.furniture.find((f) => f.model === 'sofa').pos;
  assert.deepEqual(after, before, 'the sofa must not move');
  const obstruction = out.layout.furniture.find((f) => f.prim === 'luggagerack');
  assert.ok(obstruction, 'an obstruction is placed in the walkway');
  assert.deepEqual(obstruction.pos, [0, 0.6]);
});

test('lingering equipment adds primitive props, not model lookups', () => {
  const c = baseCase({ injected: ['lingering_equipment'] });
  const out = applyDefects(layout(), c);
  const prims = out.layout.furniture.filter((f) => f.prim);
  assert.ok(prims.length >= 2);
  // A primitive prop must never masquerade as a .glb model, or the loader will
  // be asked for an asset that does not exist.
  for (const p of prims) assert.equal(p.model, undefined);
});

test('incomplete stock marks the minibar emptied rather than deleting it', () => {
  const c = baseCase({ injected: ['incomplete_stock'] });
  const out = applyDefects(layout(), c);
  const bar = out.layout.furniture.find((f) => f.model === 'minibar');
  assert.ok(bar, 'the minibar unit itself must remain in the room');
  assert.equal(bar.emptied, true);
});

test('anchors cover every injected defect and also include clean decoys', () => {
  const c = baseCase({ injected: ['room_mismatch', 'incomplete_stock'] });
  const { anchors } = applyDefects(layout(), c);
  for (const id of c.injected) {
    assert.ok(
      anchors.some((a) => a.defectId === id),
      `no anchor for ${id}`
    );
  }
  assert.ok(
    anchors.some((a) => a.defectId === null),
    'no clean decoy anchors'
  );
});

test('an anchor is never labelled with the answer', () => {
  const c = baseCase({ injected: ['lingering_equipment', 'lived_in'] });
  const { anchors } = applyDefects(layout(), c);
  for (const a of anchors) {
    assert.ok(
      !/wrong|defect|issue|error|dirty|missing/i.test(a.label),
      `anchor label gives it away: ${a.label}`
    );
  }
});

test('applying several defects at once keeps all of them present', () => {
  const c = baseCase({ injected: ['room_mismatch', 'blocked_path', 'incomplete_stock'] });
  const { layout: out, anchors } = applyDefects(layout(), c);
  assert.equal(out.furniture.filter((f) => f.model === 'twin').length, 2);
  assert.equal(out.furniture.find((f) => f.model === 'minibar').emptied, true);
  assert.equal(anchors.filter((a) => a.defectId).length, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariants checked against the REAL room layouts.
//
// The synthetic fixture above declares `model: 'sofa'` and `model: 'towelstack'`
// — keys no shipped tier actually uses. That fixture encoded the same wrong
// assumption as defects.js, so every one of those tests passed while four of the
// six defects were silently degrading in real rooms. These tests import the
// shipped layouts so a key that does not exist can never pass again.
// ─────────────────────────────────────────────────────────────────────────────

import { LAYOUTS } from '../roomLayouts.js';
import { blockersOf } from '../roomCollision.js';

const TIERS = ['Standard', 'Deluxe', 'Suite', 'Presidential'];
const ALL = DEFECTS.map((d) => d.id);
const bigParty = (tier) => baseCase({ adults: 2, children: 2, pax: 4, roomTier: tier });

// Positional identity of everything that was already in the room.
const placement = (layout) =>
  layout.furniture
    .filter((f) => !f.prim)
    .map(
      (f) => `${f.model || f.type}@${f.pos[0]},${f.pos[1]}|ry${f.ry ?? 0}|s${JSON.stringify(f.scale ?? null)}`
    )
    .sort();

test('no defect moves, rotates or resizes anything already in the room', () => {
  // The scenario may only swap or add an ASSET. If it can shove the sofa into the
  // walkway it changes the room the teacher laid out, and it can strand a student.
  for (const tier of TIERS) {
    const before = placement(LAYOUTS[tier]);
    for (const id of ALL) {
      const { layout } = applyDefects(LAYOUTS[tier], { ...bigParty(tier), injected: [id] });
      const after = placement(layout);
      // A fixture legitimately swapped for its faulted counterpart is allowed to
      // disappear; one that merely MOVED shows up as gone-from-here.
      //
      // Counting by name, not just "does one still exist": an authored layout may
      // hold several fixtures of the same kind (the Deluxe bed is a pair), and a
      // swap that consumes one of them still leaves siblings behind. A genuine
      // relocation keeps the count identical and only changes the position.
      const countBy = (keys) =>
        keys.reduce((m, k) => m.set(k.split('@')[0], (m.get(k.split('@')[0]) || 0) + 1), new Map());
      const nBefore = countBy(before);
      const nAfter = countBy(after);
      const gone = before.filter((k) => !after.includes(k));
      const movedNotSwapped = gone.filter((k) => {
        const name = k.split('@')[0];
        return (nAfter.get(name) || 0) >= (nBefore.get(name) || 0); // none consumed → it moved
      });
      assert.deepEqual(
        movedNotSwapped,
        [],
        `${tier}/${id} relocated existing fixtures: ${movedNotSwapped.join(' ')}`
      );
    }
  }
});

test('no defect adds anything a student can collide with', () => {
  // Scenario props are judged by eye. A prop that is solid can wedge a student
  // against real furniture and end the shift.
  for (const tier of TIERS) {
    const baseline = blockersOf(LAYOUTS[tier].furniture).length;
    for (const id of ALL) {
      const { layout } = applyDefects(LAYOUTS[tier], { ...bigParty(tier), injected: [id] });
      const after = blockersOf(layout.furniture).length;
      assert.ok(after <= baseline, `${tier}/${id} added ${after - baseline} collider(s)`);
    }
  }
});

test('no defect rotates a curtain or a drape', () => {
  // Tilting the window dressing reads as broken geometry, not as a teaching cue,
  // and it only ever fired in Presidential because the others declare `type`.
  for (const tier of TIERS) {
    for (const id of ALL) {
      const { layout } = applyDefects(LAYOUTS[tier], { ...bigParty(tier), injected: [id] });
      // An authored layout may declare a deliberate ry (Standard hangs its
      // curtains on the side walls), so the invariant is that a defect must not
      // CHANGE the rotation — not that the rotation is zero.
      const isDressing = (f) => f.model === 'curtain' || f.type === 'drape' || f.model === 'drape';
      const baseRy = LAYOUTS[tier].furniture
        .filter(isDressing)
        .map((f) => `${f.model || f.type}@${f.pos[0]},${f.pos[1]}|${f.ry ?? 0}`)
        .sort();
      const afterRy = layout.furniture
        .filter(isDressing)
        .map((f) => `${f.model || f.type}@${f.pos[0]},${f.pos[1]}|${f.ry ?? 0}`)
        .sort();
      assert.deepEqual(afterRy, baseRy, `${tier}/${id} changed window-dressing rotation`);
    }
  }
});

test('every injected defect produces an anchor in every real tier', () => {
  // A defect whose target key is absent yields no anchor at all — the student is
  // graded on a fault they were never shown.
  for (const tier of TIERS) {
    for (const id of ALL) {
      const c = { ...bigParty(tier), injected: [id] };
      if (!DEFECTS.find((d) => d.id === id).appliesTo(c)) continue;
      const { anchors } = applyDefects(LAYOUTS[tier], c);
      assert.ok(
        anchors.some((a) => a.defectId === id),
        `${tier}/${id} produced no anchor`
      );
    }
  }
});

test('an anchor label names the object that is actually there', () => {
  // blocked_path labelled a small brown luggage-rack primitive "Sofa", because it
  // searched for model 'sofa' while every tier declares 'sofa3'.
  for (const tier of TIERS) {
    const c = { ...bigParty(tier), injected: ['blocked_path'] };
    const { layout, anchors } = applyDefects(LAYOUTS[tier], c);
    const a = anchors.find((x) => x.defectId === 'blocked_path');
    const at = layout.furniture.find((f) => f.pos[0] === a.pos[0] && f.pos[1] === a.pos[1]);
    const realName = at?.model || at?.type || at?.prim || '(nothing)';
    assert.ok(
      a.label.toLowerCase().replace(/\s/g, '').includes(realName.toLowerCase().slice(0, 5)) ||
        realName.toLowerCase().includes(a.label.toLowerCase().replace(/\s/g, '').slice(0, 5)),
      `${tier}: anchor says "${a.label}" but the object there is "${realName}"`
    );
  }
});
