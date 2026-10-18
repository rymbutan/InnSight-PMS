import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

import { SCENARIOS, CATEGORIES, toPayload } from './inspection/tierScenarios.js';
import { fromScenario, refOf } from './inspection/scenario.js';
import { fitAddedToLayout, FOOTPRINT } from './inspection/randomScenario.js';
import { setCustomCategories, isKnownCategory } from './inspection/categories.js';
import { LAYOUTS } from './roomLayouts.js';
import { MODEL_FILES, MODEL_CFG } from './modelSizes.js';
import { blockersOf, wallBlockers } from './roomCollision.js';

// The API's own validator: a payload it would reject is a scenario that can
// never be saved, whatever the game thinks of it.
const require = createRequire(import.meta.url);
const { validateScenario } = require('../../../services/auth/src/lib/scenarioValidation.js');

const TIERS = ['Standard', 'Deluxe', 'Suite', 'Presidential'];
const byTier = (t) => SCENARIOS.filter((s) => s.roomTier === t);

// What the seed script would learn from the database.
const CATEGORY_IDS = Object.fromEntries(CATEGORIES.map((c) => [c.key, `custom_${c.key}`]));
setCustomCategories(
  CATEGORIES.map((c) => ({ id: CATEGORY_IDS[c.key], label: c.label, why: c.why, feedback: c.feedback }))
);

const r2 = (n) => Math.round(n * 100) / 100;
const solids = (plan) => [...blockersOf(plan.furniture), ...wallBlockers(plan.walls)];
const inside = (x, z, boxes, pad = 0) =>
  boxes.some(([a, b, c, d]) => x > a - pad && x < b + pad && z > c - pad && z < d + pad);
const half = (plan) => [(plan.w || 5) / 2, (plan.l || 6) / 2];

function distToSegment(px, pz, [ax, az], [bx, bz]) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

// Which free-floor cells a person standing at spawn can walk to (0.2 m grid, a
// 0.25 m body, the same margin roomCollision uses). A prop sealed in a corner
// behind furniture is a fault nobody can inspect.
function reachable(plan, extra = []) {
  const boxes = [...solids(plan), ...extra];
  const [hw, hl] = half(plan);
  const step = 0.2;
  const key = (i, j) => `${i},${j}`;
  const cell = (x, z) => [Math.round(x / step), Math.round(z / step)];
  const free = (i, j) => {
    const x = i * step;
    const z = j * step;
    return Math.abs(x) < hw - 0.15 && Math.abs(z) < hl - 0.15 && !inside(x, z, boxes, 0.2);
  };
  // The spawn is the doorway, which sits on or just past the room's edge, so the
  // walk starts from the nearest free floor to it rather than from the spawn.
  const [ci0, cj0] = cell(plan.spawn[0], plan.spawn[1]);
  let start = null;
  for (let r = 0; r <= 20 && !start; r += 1) {
    for (let di = -r; di <= r && !start; di += 1)
      for (let dj = -r; dj <= r && !start; dj += 1) {
        if (Math.max(Math.abs(di), Math.abs(dj)) === r && free(ci0 + di, cj0 + dj))
          start = [ci0 + di, cj0 + dj];
      }
  }
  assert.ok(start, 'no free floor near the doorway');
  const seen = new Set([key(...start)]);
  const queue = [start];
  while (queue.length) {
    const [i, j] = queue.pop();
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const ni = i + di;
      const nj = j + dj;
      if (seen.has(key(ni, nj)) || !free(ni, nj)) continue;
      seen.add(key(ni, nj));
      queue.push([ni, nj]);
    }
  }
  return (x, z) => {
    // Reaching a prop means reaching ground within an arm's length of it.
    const [ci, cj] = cell(x, z);
    for (let di = -4; di <= 4; di += 1)
      for (let dj = -4; dj <= 4; dj += 1) {
        if (Math.hypot(di, dj) * step <= 0.8 && seen.has(key(ci + di, cj + dj))) return true;
      }
    return false;
  };
}

function surfaceTop(f) {
  const cfg = MODEL_CFG[f.model] || {};
  const h = f.size?.[1] ?? f.h ?? cfg.size?.[1] ?? cfg.h;
  return h ? (f.y ?? 0) + h * (f.scale?.[1] ?? 1) : null;
}

// ── structure ────────────────────────────────────────────────────────────────

test('three scenarios per tier, with unique names and keys', () => {
  assert.equal(SCENARIOS.length, 12);
  for (const t of TIERS) assert.equal(byTier(t).length, 3, `${t} needs three scenarios`);
  assert.equal(new Set(SCENARIOS.map((s) => s.name)).size, 12);
  assert.equal(new Set(SCENARIOS.map((s) => s.key)).size, 12);
});

test('every scenario has at least three faults and two decoys', () => {
  for (const s of SCENARIOS) {
    const faults = s.tags.filter((t) => t.defectId);
    const decoys = s.tags.filter((t) => !t.defectId);
    assert.ok(faults.length >= 3, `${s.key} has ${faults.length} faults`);
    assert.ok(decoys.length >= 2, `${s.key} has ${decoys.length} decoys`);
  }
});

test('within a tier, scenarios share no fault asset and no placement', () => {
  for (const t of TIERS) {
    const seenModels = new Map();
    const seenSpots = new Map();
    for (const s of byTier(t)) {
      const faultRefs = new Set(s.tags.filter((x) => x.defectId).map((x) => x.ref));
      const models = new Set();
      for (const [ref, to] of Object.entries(s.swaps || {})) {
        if (faultRefs.has(ref)) models.add(typeof to === 'string' ? to : to.model);
      }
      for (const a of s.added || []) if (faultRefs.has(a.id)) models.add(a.model);
      for (const m of models) {
        assert.ok(!seenModels.has(m), `${t}: "${m}" is a fault in both ${seenModels.get(m)} and ${s.key}`);
        seenModels.set(m, s.key);
      }
      for (const a of s.added || []) {
        if (a.y) continue; // a tabletop prop shares its table's spot by design
        const k = `${r2(a.pos[0])},${r2(a.pos[1])}`;
        assert.ok(!seenSpots.has(k), `${t}: ${seenSpots.get(k)} and ${s.key} both place a prop at ${k}`);
        seenSpots.set(k, s.key);
      }
    }
  }
});

test('labels name the object and never give away its condition', () => {
  const giveaway = /\b(dirty|unmade|messy|empty|broken|soiled|used|overflowing|blocked|stained)\b/i;
  for (const s of SCENARIOS) {
    for (const t of s.tags) {
      if (t.label) assert.ok(!giveaway.test(t.label), `${s.key}: label "${t.label}" leaks the answer`);
    }
  }
});

// ── resolves against the live layouts ────────────────────────────────────────

test('every swap and fixture tag points at a fixture that exists', () => {
  for (const s of SCENARIOS) {
    const refs = new Set(LAYOUTS[s.roomTier].furniture.map(refOf));
    const addedIds = new Set((s.added || []).map((a) => a.id));
    assert.equal(addedIds.size, (s.added || []).length, `${s.key}: duplicate added ids`);
    for (const ref of Object.keys(s.swaps || {}))
      assert.ok(refs.has(ref), `${s.key}: swap "${ref}" is not in ${s.roomTier}`);
    for (const t of s.tags)
      assert.ok(refs.has(t.ref) || addedIds.has(t.ref), `${s.key}: tag "${t.ref}" resolves to nothing`);
  }
});

test('every model used is a registered asset', () => {
  for (const s of SCENARIOS) {
    for (const to of Object.values(s.swaps || {})) {
      const m = typeof to === 'string' ? to : to.model;
      assert.ok(MODEL_FILES[m], `${s.key}: swap target "${m}" is not a registered model`);
    }
    for (const a of s.added || [])
      assert.ok(MODEL_FILES[a.model], `${s.key}: "${a.model}" is not a registered model`);
  }
});

test('a faulted fixture cannot grow into a wall or another fixture', () => {
  // The same rule the random generator applies (swapFits): an unmade sofa bed is
  // deeper than the sofa it replaces, so next to a wall it would poke through.
  for (const s of SCENARIOS) {
    const plan = LAYOUTS[s.roomTier];
    const boxes = solids(plan);
    const [hw, hl] = half(plan);
    for (const [ref, to] of Object.entries(s.swaps || {})) {
      const o = plan.furniture.find((f) => refOf(f) === ref);
      const target = typeof to === 'string' ? to : to.model;
      const from = FOOTPRINT[o.model];
      const next = FOOTPRINT[target];
      if (!o.box || !from || !next) continue;
      let w = Math.abs(o.box[0] * (o.scale?.[0] ?? 1));
      let d = Math.abs(o.box[1] * (o.scale?.[2] ?? 1));
      const gw = w * Math.max(1, next[0] / from[0]);
      const gd = d * Math.max(1, next[1] / from[1]);
      if (gw <= w + 0.05 && gd <= d + 0.05) continue;
      [w, d] = [gw, gd];
      const [x, z] = o.pos;
      assert.ok(
        Math.abs(x) + w / 2 <= hw - 0.05 && Math.abs(z) + d / 2 <= hl - 0.05,
        `${s.key}: ${target} grows out of the room`
      );
      const others = boxes.filter(
        ([a, b, c, e]) => !(Math.abs((a + b) / 2 - x) < 0.01 && Math.abs((c + e) / 2 - z) < 0.01)
      );
      const hit = others.find(
        ([a, b, c, e]) => x - w / 2 < b && x + w / 2 > a && z - d / 2 < e && z + d / 2 > c
      );
      assert.ok(!hit, `${s.key}: ${ref} → ${target} grows into another fixture`);
    }
  }
});

// ── placement ────────────────────────────────────────────────────────────────

test('floor props stand on clear ground, off the entry lane, and can be reached', () => {
  for (const s of SCENARIOS) {
    const plan = LAYOUTS[s.roomTier];
    const boxes = solids(plan);
    const [hw, hl] = half(plan);
    const spawn = plan.spawn;
    const blocking = new Set(s.tags.filter((t) => t.defectId === 'blocked_path').map((t) => t.ref));
    // Every other floor prop is an obstacle for the reachability test.
    const floor = (s.added || []).filter((a) => !a.y && !blocking.has(a.id));
    const dropped = (s.added || []).filter((a) => !a.y && blocking.has(a.id));
    for (const a of floor) {
      const [x, z] = a.pos;
      const where = `${s.key}: ${a.id} at [${x}, ${z}]`;
      assert.ok(Math.abs(x) <= hw - 0.3 && Math.abs(z) <= hl - 0.3, `${where} is outside the room`);
      assert.ok(!inside(x, z, boxes, 0.3), `${where} is inside furniture`);
      assert.ok(Math.hypot(x - spawn[0], z - spawn[1]) >= 1.4, `${where} is on top of the doorway`);
      assert.ok(distToSegment(x, z, spawn, [0, 0]) >= 0.8, `${where} sits on the entry lane`);
    }
    const reach = reachable(
      plan,
      floor.map((a) => [a.pos[0] - 0.2, a.pos[0] + 0.2, a.pos[1] - 0.2, a.pos[1] + 0.2])
    );
    for (const a of [...floor, ...dropped]) {
      assert.ok(reach(a.pos[0], a.pos[1]), `${s.key}: ${a.id} at [${a.pos}] cannot be reached from the door`);
    }
    // The bench is allowed ON the route, but the room behind it must stay walkable
    // around it: it is a fault to spot, not a wall that traps the student.
    for (const a of dropped) {
      const [x, z] = a.pos;
      assert.ok(!inside(x, z, boxes, 0.2), `${s.key}: ${a.id} is inside furniture`);
      assert.ok(
        distToSegment(x, z, spawn, [0, 0]) < 1.6,
        `${s.key}: ${a.id} is not actually on the route in`
      );
    }
  }
});

test('tabletop props sit on a real surface at its real height', () => {
  for (const s of SCENARIOS) {
    const plan = LAYOUTS[s.roomTier];
    for (const a of (s.added || []).filter((x) => x.y)) {
      const table =
        plan.furniture.find(
          (f) => Math.hypot(f.pos[0] - a.pos[0], f.pos[1] - a.pos[1]) < 0.05 && surfaceTop(f) !== null
        ) ||
        (s.added || []).find(
          (o) =>
            o !== a &&
            !o.y &&
            Math.hypot(o.pos[0] - a.pos[0], o.pos[1] - a.pos[1]) < 0.05 &&
            surfaceTop(o) !== null
        );
      assert.ok(table, `${s.key}: ${a.id} is not standing on anything`);
      assert.ok(
        Math.abs(surfaceTop(table) - a.y) <= 0.03,
        `${s.key}: ${a.id} y=${a.y} but ${table.model} top is ${r2(surfaceTop(table))}`
      );
    }
  }
});

test('the live game does not need to move or drop a single prop', () => {
  for (const s of SCENARIOS) {
    const plan = LAYOUTS[s.roomTier];
    const added = (s.added || []).map((a) => ({ ...a, added: true }));
    const fit = fitAddedToLayout(added, plan, s.tags);
    assert.deepEqual(fit.moved, [], `${s.key}: props would be moved at play time`);
    assert.deepEqual(fit.dropped, [], `${s.key}: props would be dropped at play time`);
  }
});

// ── plays through the real game path ─────────────────────────────────────────

test('every fault survives into the case file for ANY booking', () => {
  // A fault demoted to a decoy because the reservation does not support it would
  // mark a student wrong for signing off a correct room. Each scenario is drawn
  // against many reservations, solo travellers to families.
  const parties = [
    { adults: 1, children: 0 },
    { adults: 2, children: 0 },
    { adults: 2, children: 2 },
    { adults: 3, children: 0 },
    { adults: 4, children: 0 },
  ];
  for (const s of SCENARIOS) {
    const payload = toPayload(s, CATEGORY_IDS);
    const wanted = new Set(payload.tags.filter((t) => t.defectId).map((t) => t.defectId));
    for (const p of parties) {
      const reservation = { adults: p.adults, children: p.children, guestName: 'Test Guest' };
      const out = fromScenario({ ...payload, id: s.key }, { reservation, rng: () => 0.5 });
      const have = new Set(out.caseFile.injected);
      for (const id of wanted)
        assert.ok(have.has(id), `${s.key}: "${id}" was demoted for a party of ${p.adults}+${p.children}`);
      const live = out.anchors.filter((a) => a.defectId).length;
      assert.equal(live, payload.tags.filter((t) => t.defectId).length, `${s.key}: a fault lost its anchor`);
      assert.equal(out.fit.dropped.length, 0);
      assert.equal(out.anchors.length, payload.tags.length, `${s.key}: a tag did not resolve`);
    }
  }
});

test('every category id a scenario uses is a known category', () => {
  for (const s of SCENARIOS) {
    for (const t of toPayload(s, CATEGORY_IDS).tags) {
      if (t.defectId) assert.ok(isKnownCategory(t.defectId), `${s.key}: unknown category ${t.defectId}`);
    }
  }
});

test('the custom categories have the explanation grading needs', () => {
  for (const c of CATEGORIES) {
    assert.ok(c.label.trim() && c.why.trim() && c.feedback.trim(), `${c.key} is incomplete`);
  }
  assert.equal(new Set(CATEGORIES.map((c) => c.label.toLowerCase())).size, CATEGORIES.length);
});

test('the API accepts every payload as written', () => {
  for (const s of SCENARIOS) {
    const r = validateScenario(toPayload(s, CATEGORY_IDS));
    assert.ok(r.ok, `${s.key}: ${r.error}`);
  }
});
