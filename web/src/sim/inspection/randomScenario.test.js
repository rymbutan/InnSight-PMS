import test from 'node:test';
import assert from 'node:assert';

import { generateRandomScenario, fitAddedToLayout, makeRng, LEVELS } from './randomScenario.js';
import { buildScenarioPayload, savableProblem } from './scenarioEdit.js';
import { fromScenario, refOf, scenarioCounts } from './scenario.js';
import { isKnownCategory } from './categories.js';
import { LAYOUTS } from '../roomLayouts.js';
import { blockersOf, wallBlockers } from '../roomCollision.js';

const TIERS = Object.keys(LAYOUTS);
let n = 0;
const makeId = () => `t${(n += 1)}`;

// What the editor's seedFromTier produces.
const seedObjects = (plan) =>
  plan.furniture.map((f) => ({
    ...f,
    id: makeId(),
    _ref: refOf(f),
    _baseModel: f.model,
    _baseRy: f.ry ?? 0,
    _baseScale: f.scale || [1, 1, 1],
    _baseY: f.y ?? 0,
    defectId: undefined,
    label: undefined,
  }));

const roll = (tier, seed, opts = {}) => {
  const plan = LAYOUTS[tier];
  return { plan, ...generateRandomScenario({ plan, baseObjects: seedObjects(plan), makeId, seed, ...opts }) };
};

const solidBoxes = (plan) => [...blockersOf(plan.furniture), ...wallBlockers(plan.walls)];

test('every tier, many seeds: a savable scenario with at least one fault', () => {
  for (const tier of TIERS) {
    for (let seed = 1; seed <= 150; seed += 1) {
      const r = roll(tier, seed, { level: 'hard' });
      assert.ok(r.faults >= 1, `${tier} seed ${seed} produced no fault`);
      const payload = buildScenarioPayload({ objects: r.objects, name: 'x', tier });
      const c = scenarioCounts(payload);
      assert.ok(c.faults >= 1, `${tier} seed ${seed}: no tagged fault in the payload`);
      assert.equal(savableProblem(payload, c.faults), '', `${tier} seed ${seed} not savable`);
    }
  }
});

test('never exceeds the requested number of faults, and decoys are produced', () => {
  for (const level of Object.keys(LEVELS)) {
    for (const tier of TIERS) {
      for (let seed = 1; seed <= 40; seed += 1) {
        const r = roll(tier, seed, { level });
        assert.ok(r.faults <= LEVELS[level].faults, `${tier}/${level}/${seed}: ${r.faults} faults`);
        assert.ok(r.decoys >= 1, `${tier}/${level}/${seed}: no decoys`);
      }
    }
  }
});

test('same seed, same scenario; different seeds differ', () => {
  const a = roll('Deluxe', 42);
  const b = roll('Deluxe', 42);
  const strip = (x) => JSON.stringify(x.objects.map(({ id: _id, ...o }) => o));
  assert.equal(strip(a), strip(b));
  const seen = new Set();
  for (let s = 1; s <= 30; s += 1) seen.add(strip(roll('Deluxe', s)));
  assert.ok(seen.size > 15, `only ${seen.size} distinct scenarios in 30 seeds`);
});

test('built-in fixtures are never moved', () => {
  for (const tier of TIERS) {
    for (let seed = 1; seed <= 60; seed += 1) {
      const plan = LAYOUTS[tier];
      const r = roll(tier, seed, { level: 'hard' });
      const base = r.objects.filter((o) => !o.added);
      assert.equal(base.length, plan.furniture.length);
      base.forEach((o, i) =>
        assert.deepEqual(o.pos, plan.furniture[i].pos, `${tier}/${seed} moved ${o.model}`)
      );
    }
  }
});

test('added props sit in the room, off solid furniture and off the doorstep', () => {
  for (const tier of TIERS) {
    const plan = LAYOUTS[tier];
    const boxes = solidBoxes(plan);
    for (let seed = 1; seed <= 150; seed += 1) {
      const r = roll(tier, seed, { level: 'hard' });
      for (const o of r.objects.filter((x) => x.added && x.defectId !== 'blocked_path')) {
        const [x, z] = o.pos;
        assert.ok(
          Math.abs(x) < plan.w / 2 && Math.abs(z) < plan.l / 2,
          `${tier}/${seed}: ${o.model} outside`
        );
        const inside = boxes.some(([a, b, c, d]) => x > a && x < b && z > c && z < d);
        assert.ok(!inside, `${tier}/${seed}: ${o.model} inside furniture at ${x},${z}`);
        assert.ok(Math.hypot(x - plan.spawn[0], z - plan.spawn[1]) > 1, `${tier}/${seed}: on the doorstep`);
      }
    }
  }
});

test('every tag uses a known category, every tagged ref is unique', () => {
  for (const tier of TIERS) {
    for (let seed = 1; seed <= 60; seed += 1) {
      const r = roll(tier, seed, { level: 'hard', includeBookingFaults: true });
      const payload = buildScenarioPayload({ objects: r.objects, name: 'x', tier });
      const refs = payload.tags.map((t) => t.ref);
      assert.equal(new Set(refs).size, refs.length, `${tier}/${seed}: duplicate tag refs`);
      for (const t of payload.tags) {
        if (t.defectId) assert.ok(isKnownCategory(t.defectId), `${t.defectId} unknown`);
      }
    }
  }
});

test('a fault is only offered when the layout owns the fixture', () => {
  // A room with no minibar, toilet or towels can never be told those stories.
  const plan = {
    ...LAYOUTS.Standard,
    furniture: LAYOUTS.Standard.furniture.filter((f) => f.model === 'bed'),
  };
  for (let seed = 1; seed <= 60; seed += 1) {
    const r = generateRandomScenario({ plan, baseObjects: seedObjects(plan), makeId, seed, level: 'hard' });
    for (const o of r.objects) {
      assert.ok(!['fridgeempty', 'dirtytoilet', 'dirtysink', 'towelfloor', 'towel'].includes(o.model));
    }
  }
});

test('round trip: what is generated is what the inspection builds', () => {
  for (const tier of TIERS) {
    for (let seed = 1; seed <= 40; seed += 1) {
      const r = roll(tier, seed);
      const payload = buildScenarioPayload({ objects: r.objects, name: 'x', tier });
      const out = fromScenario({ ...payload, id: 's', roomTier: tier }, { rng: makeRng(seed) });
      assert.equal(out.anchors.length, payload.tags.length, `${tier}/${seed}: anchors lost`);
      assert.ok(
        out.anchors.some((a) => a.defectId),
        `${tier}/${seed}: no real fault survived`
      );
    }
  }
});

// ── fitAddedToLayout ─────────────────────────────────────────────────────────

const plan = LAYOUTS.Standard;

test('fit: a prop in clear floor is left exactly where it is', () => {
  const a = { id: 'a', model: 'cleaningcart', pos: [0.5, 1.9], ry: 1 };
  const r = fitAddedToLayout([a], plan);
  assert.deepEqual(r, { added: [a], moved: [], dropped: [] });
});

test('fit: a prop inside a wardrobe is nudged out of it', () => {
  // The Standard wardrobe stands at [-2.9, -2.1].
  const a = { id: 'a', model: 'cleaningcart', pos: [-2.9, -2.1], ry: 0 };
  const r = fitAddedToLayout([a], plan);
  assert.deepEqual(r.moved, ['a']);
  assert.equal(r.dropped.length, 0);
  const [x, z] = r.added[0].pos;
  assert.ok(!solidBoxes(plan).some(([p, q, c, d]) => x > p && x < q && z > c && z < d));
});

test('fit: a prop outside the room is pulled back in, or dropped', () => {
  const r = fitAddedToLayout([{ id: 'a', model: 'dishes', pos: [40, 40], ry: 0 }], plan);
  assert.equal(r.dropped.length + r.moved.length, 1);
});

test('fit: a raised prop (on a table) is never moved', () => {
  const a = { id: 'a', model: 'dishes', pos: [-2.9, -2.1], y: 0.9, ry: 0 };
  assert.deepEqual(fitAddedToLayout([a], plan).added, [a]);
});

test('fit: the blocked-walkway fault is exempt', () => {
  const a = { id: 'b', model: 'divider', pos: [-2.9, -2.1], ry: 0 };
  const r = fitAddedToLayout([a], plan, [{ ref: 'b', defectId: 'blocked_path' }]);
  assert.deepEqual(r.added, [a]);
});

test('fit: with no room at all the prop is dropped, not placed on furniture', () => {
  const full = { ...plan, w: 1, l: 1, furniture: [{ model: 'wardrobe', pos: [0, 0], box: [4, 4] }] };
  const r = fitAddedToLayout([{ id: 'a', model: 'dishes', pos: [0, 0], ry: 0 }], full);
  assert.deepEqual(r.dropped, ['a']);
});

test('fit: fromScenario reports what it moved', () => {
  const sc = {
    id: 's',
    name: 'n',
    roomTier: 'Standard',
    swaps: {},
    added: [{ id: 'a', model: 'cleaningcart', pos: [-2.9, -2.1], ry: 0 }],
    tags: [{ ref: 'a', defectId: 'lingering_equipment', label: 'Cart' }],
    furniture: [],
    anchors: [],
  };
  const out = fromScenario(sc, { rng: makeRng(1) });
  assert.deepEqual(out.fit.moved, ['a']);
});
