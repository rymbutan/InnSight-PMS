import test from 'node:test';
import assert from 'node:assert';

import { generateRandomScenario, fitAddedToLayout, makeRng, LEVELS, FOOTPRINT } from './randomScenario.js';
import { MODEL_FILES, renderedSize } from '../modelSizes.js';
import { readFileSync } from 'node:fs';
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
      // Tabletop props (y > 0) stand ON a fixture, so they are meant to be inside its box.
      for (const o of r.objects.filter((x) => x.added && x.defectId !== 'blocked_path' && !x.y)) {
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
    // Swaps only: an ADDED towel on the floor needs no towel fixture.
    for (const o of r.objects.filter((x) => !x.added)) {
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

test('FOOTPRINT matches what the room actually renders', () => {
  const metrics = JSON.parse(
    readFileSync(new URL('../../../../scripts/model-metrics.json', import.meta.url), 'utf8')
  ).models;
  for (const [model, [w, d]] of Object.entries(FOOTPRINT)) {
    const native = metrics[MODEL_FILES[model]];
    assert.ok(native, `no measured size for ${model}`);
    const [rw, , rd] = renderedSize({ model }, native);
    assert.ok(Math.abs(rw - w) < 0.02 && Math.abs(rd - d) < 0.02, `${model}: table ${w}x${d}, rendered ${rw.toFixed(2)}x${rd.toFixed(2)}`);
  }
});

test('a swap never grows into a wall, another fixture or out of the room', () => {
  for (const tier of TIERS) {
    for (let seed = 1; seed <= 80; seed += 1) {
      const plan = LAYOUTS[tier];
      const r = roll(tier, seed, { level: 'hard' });
      const others = solidBoxes(plan);
      r.objects.forEach((o, i) => {
        const base = plan.furniture[i];
        if (o.added || !base || o.model === base.model || !o.box || !FOOTPRINT[o.model] || !FOOTPRINT[base.model]) return;
        const k = [Math.max(1, FOOTPRINT[o.model][0] / FOOTPRINT[base.model][0]), Math.max(1, FOOTPRINT[o.model][1] / FOOTPRINT[base.model][1])];
        let [w, d] = [o.box[0] * (o.scale?.[0] ?? 1) * k[0], o.box[1] * (o.scale?.[2] ?? 1) * k[1]];
        if (Math.abs(((o.ry ?? 0) % Math.PI + Math.PI) % Math.PI - Math.PI / 2) < 0.5) [w, d] = [d, w];
        if (k[0] <= 1.05 && k[1] <= 1.05) return;
        const [x, z] = o.pos;
        assert.ok(Math.abs(x) + w / 2 <= plan.w / 2, `${tier}/${seed}: ${o.model} pokes out of the room`);
        assert.ok(Math.abs(z) + d / 2 <= plan.l / 2, `${tier}/${seed}: ${o.model} pokes out of the room`);
        const self = blockersOf([base])[0];
        for (const b of others) {
          if (b === self || b.every((v, j) => v === self[j])) continue;
          const hit = x - w / 2 < b[1] && x + w / 2 > b[0] && z - d / 2 < b[3] && z + d / 2 > b[2];
          assert.ok(!hit, `${tier}/${seed}: ${o.model} grows into ${b[4]}`);
        }
      });
    }
  }
});

test('carts are laid square to a wall or to the room, not at a random angle', () => {
  let seen = 0;
  for (const tier of TIERS) {
    for (let seed = 1; seed <= 120; seed += 1) {
      for (const o of roll(tier, seed, { level: 'hard' }).objects) {
        if (!o.added || o.defectId === 'blocked_path' || o.model !== 'cleaningcart') continue;
        seen += 1;
        const off = Math.abs((o.ry % (Math.PI / 2) + Math.PI / 2) % (Math.PI / 2));
        const dev = Math.min(off, Math.PI / 2 - off);
        assert.ok(dev < 0.07, `${tier}/${seed}: ${o.model} at ry ${o.ry}`);
      }
    }
  }
  assert.ok(seen > 0, 'no long prop was ever generated');
});

test('the whole prop library is used: every clutter, tabletop and decoy asset turns up', () => {
  const seen = new Set();
  for (const tier of TIERS) {
    for (let seed = 1; seed <= 300; seed += 1) {
      for (const o of roll(tier, seed, { level: 'hard' }).objects) seen.add(o.model);
    }
  }
  const expected = [
    'dishes', 'trashcan', 'clutterpile', 'canA', 'canB', 'rat', 'towelfloor', 'toiletry', 'cleaningsupply',
    'cleaningcart', 'dirtymattress', 'messybed', 'messybed2', 'pottedplant', 'accentchair', 'sidetable',
    'ottoman', 'woodring', 'woodring2', 'playkitchen', 'orchid', 'desklamp',
  ];
  for (const m of expected) assert.ok(seen.has(m), `${m} was never generated`);
});

test('tabletop props rest on the surface they stand on, not in the floor or the air', () => {
  let seen = 0;
  for (const tier of TIERS) {
    const plan = LAYOUTS[tier];
    for (let seed = 1; seed <= 100; seed += 1) {
      for (const o of roll(tier, seed, { level: 'hard' }).objects.filter((x) => x.added && x.y)) {
        seen += 1;
        const under = plan.furniture.find(
          (f) => f.model && ['coffee', 'desk', 'nightstand', 'sidetable'].includes(f.model) && Math.hypot(f.pos[0] - o.pos[0], f.pos[1] - o.pos[1]) < 0.3
        );
        assert.ok(under, `${tier}/${seed}: ${o.model} floats at ${o.pos}`);
        assert.ok(o.y >= 0.3 && o.y <= 1.05, `${tier}/${seed}: ${o.model} at height ${o.y}`);
      }
    }
  }
  assert.ok(seen > 0, 'no tabletop prop was ever generated');
});

test('re-rolling varies: consecutive rolls share few faults, and no story dominates', () => {
  for (const tier of ['Deluxe', 'Presidential']) {
    const count = {};
    let shared = 0;
    let total = 0;
    let recent = [];
    for (let seed = 1; seed <= 200; seed += 1) {
      const r = roll(tier, seed, { level: 'medium', recent });
      const faultKeys = r.keys.filter((k) => !k.startsWith('decoy:'));
      const prev = new Set((recent[0] || []).filter((k) => !k.startsWith('decoy:')));
      shared += faultKeys.filter((k) => prev.has(k)).length;
      total += faultKeys.length;
      faultKeys.forEach((k) => (count[k] = (count[k] || 0) + 1));
      recent = [r.keys, ...recent].slice(0, 2);
    }
    assert.ok(shared / total < 0.2, `${tier}: ${Math.round((100 * shared) / total)}% of faults repeat the last roll`);
    const kinds = Object.keys(count).length;
    assert.ok(kinds >= 10, `${tier}: only ${kinds} different faults in 200 rolls: ${JSON.stringify(count)}`);
    const top = Math.max(...Object.values(count)) / total;
    assert.ok(top < 0.2, `${tier}: one fault is ${Math.round(top * 100)}% of everything`);
  }
});
