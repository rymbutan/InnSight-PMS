// ─────────────────────────────────────────────────────────────────────────────
// The scenario randomizer: one click builds a complete, savable scenario for a
// room tier. Pure — no React, no three.js, no network — so node --test can drive
// it across every tier and thousands of seeds.
//
// WHAT IT MAY CHANGE is exactly what a scenario may change (see fromScenario):
// the asset, facing, size and height of a built-in fixture, and any objects it
// ADDS. It never moves a built-in fixture. So "random" here means: which fixtures
// are made faulty, which props are added where, and which clean fixtures are left
// as decoys.
//
// IT READS THE LIVE LAYOUT. Every choice is tested against the tier's current
// fixtures and walls (the same collision boxes the student walks into), so a
// room authored in the Room Layout editor gets scenarios that fit it, and a
// fault is only offered when the layout owns the fixture it needs — a Standard
// room with no minibar never gets a minibar fault.
//
// THE SECOND HALF OF THIS FILE is the other direction: a scenario is a snapshot,
// the layout is live, and props placed against yesterday's layout can end up
// inside today's wardrobe. fitAddedToLayout() re-checks them at play time.
// ─────────────────────────────────────────────────────────────────────────────

import { blockersOf, wallBlockers } from '../roomCollision.js';
import { labelFor } from './assetFamilies.js';
import { MODEL_CFG } from '../modelSizes.js';

/**
 * How many faults / decoys each difficulty aims for. A layout may allow fewer.
 * `props` is how many of the decoys are harmless objects ADDED to the room (a
 * plant, an accent chair) on top of the built-in fixtures left clean.
 */
export const LEVELS = {
  easy: { label: 'Easy', faults: 2, decoys: 3, props: 1 },
  medium: { label: 'Medium', faults: 4, decoys: 4, props: 2 },
  hard: { label: 'Hard', faults: 6, decoys: 5, props: 3 },
};

// ── Seeded randomness ────────────────────────────────────────────────────────
// mulberry32. A seed makes a roll reproducible, which is what lets a scenario
// that came out well be regenerated, and what lets the tests assert on it.
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const newSeed = () => Math.floor(Math.random() * 2147483647) + 1;

const r2 = (n) => Math.round(n * 100) / 100;
const pick = (list, rng) => list[Math.floor(rng() * list.length)];

// Fisher-Yates — `sort(() => 0.5 - rng())` is not uniform (see caseFile.js).
function shuffled(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function weightedIndex(weights, rng) {
  const total = weights.reduce((a, b) => a + b, 0);
  let t = rng() * total;
  for (let i = 0; i < weights.length; i += 1) {
    t -= weights[i];
    if (t < 0) return i;
  }
  return weights.length - 1;
}

// ── Room geometry ────────────────────────────────────────────────────────────
// Every solid thing a student can bump into, as [minX, maxX, minZ, maxZ] boxes.
const solidBoxes = (plan) => [...blockersOf(plan.furniture), ...wallBlockers(plan.walls)];

const insideBox = (x, z, boxes, pad = 0) =>
  boxes.some(([a, b, c, d]) => x > a - pad && x < b + pad && z > c - pad && z < d + pad);

function distToSegment(px, pz, [ax, az], [bx, bz]) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

const roomHalf = (plan, margin) => ({
  hw: Math.max(0.5, (plan.w || 5) / 2 - margin),
  hl: Math.max(0.5, (plan.l || 6) / 2 - margin),
});

// ── Footprints of the assets a swap can bring in ─────────────────────────────
// Rendered [x, z] extent in metres at scale 1, from the same fit rules the room
// uses (renderedSize over scripts/model-metrics.json — randomScenario.test.js
// recomputes this table and fails if it drifts). A swap keeps the original's
// position, so a replacement that is bigger than what it replaces grows over the
// floor around it: an unmade sofa bed is 1.64 m deep where the sofa is 0.95 m, and
// next to a wall or a coffee table that is a bed poking through them.
export const FOOTPRINT = {
  bed: [1.95, 2.05],
  bedplain: [1.95, 2.05],
  messybed: [1.95, 2.05],
  messybed2: [1.95, 2.05],
  dirtymattress: [1.4, 1.9],
  sofa3: [2.26, 0.95],
  unmadesofabed: [1.64, 1.64],
  toilet: [0.34, 0.63],
  dirtytoilet: [0.49, 0.73],
  vanity: [1.6, 0.56],
  dirtysink: [0.55, 0.4],
  towelstack: [0.38, 0.28],
  towel: [0.32, 0.23],
  towelfloor: [0.68, 0.7],
  minibar: [1.13, 0.66],
  fridgestocked: [1.11, 1.11],
  fridgeempty: [0.9, 0.61],
};

// World-space [w, d] of a fixture's collision box — the same maths as blockersOf,
// so "the box the student bumps into" and "the box I am checking" cannot differ.
function boxExtent(o) {
  if (!o.box) return null;
  let [w, d] = o.box;
  if (o.scale) {
    w *= o.scale[0];
    d *= o.scale[2];
  }
  return [Math.abs(w), Math.abs(d)];
}

const quarterTurned = (ry) =>
  !!ry && Math.abs((((ry % Math.PI) + Math.PI) % Math.PI) - Math.PI / 2) < 0.5;

/**
 * Can `o` become `to` without the replacement growing into a wall, another solid
 * fixture or out of the room? A replacement no bigger than the original always
 * can. Fixtures with no collision box are walk-through decor and always can.
 */
function swapFits(ctx, o, to) {
  const ext = boxExtent(o);
  const from = FOOTPRINT[o.model];
  const next = FOOTPRINT[to];
  if (!ext || !from || !next) return true;
  let w = ext[0] * Math.max(1, next[0] / from[0]);
  let d = ext[1] * Math.max(1, next[1] / from[1]);
  if (w <= ext[0] + 0.05 && d <= ext[1] + 0.05) return true;
  if (quarterTurned(o.ry)) [w, d] = [d, w];
  const [x, z] = o.pos;
  const half = [(ctx.plan.w || 5) / 2, (ctx.plan.l || 6) / 2];
  if (Math.abs(x) + w / 2 > half[0] - 0.05 || Math.abs(z) + d / 2 > half[1] - 0.05) return false;
  // Everything solid EXCEPT the fixture itself (its own box is the one being grown).
  const own = boxExtent(o);
  const [ow, od] = quarterTurned(o.ry) ? [own[1], own[0]] : own;
  const others = ctx.boxes.filter(
    ([a, b, c, e]) =>
      !(Math.abs((a + b) / 2 - x) < 0.01 && Math.abs((c + e) / 2 - z) < 0.01 && Math.abs(b - a - ow) < 0.01 && Math.abs(e - c - od) < 0.01)
  );
  return !others.some(([a, b, c, e]) => x - w / 2 < b && x + w / 2 > a && z - d / 2 < e && z + d / 2 > c);
}

// The route a guest takes: from where they come in to the middle of the room.
// Props are kept off it so a random cart cannot wall off the room by accident;
// only the blocked-walkway fault is allowed to stand on it, on purpose.
const spawnOf = (plan) => (Array.isArray(plan.spawn) ? plan.spawn : [0, 0]);
const LANE_CLEAR = 0.8;
const SPAWN_CLEAR = 1.4;

/** A random free floor spot, or null when the room has no room left. */
function findSpot({ rng, plan, boxes, avoid, keepLaneClear = true, tries = 80 }) {
  const { hw, hl } = roomHalf(plan, 0.6);
  const spawn = spawnOf(plan);
  for (let i = 0; i < tries; i += 1) {
    const x = (rng() * 2 - 1) * hw;
    const z = (rng() * 2 - 1) * hl;
    if (insideBox(x, z, boxes, 0.35)) continue;
    if (Math.hypot(x - spawn[0], z - spawn[1]) < SPAWN_CLEAR) continue;
    if (keepLaneClear && distToSegment(x, z, spawn, [0, 0]) < LANE_CLEAR) continue;
    if (avoid.some(([ax, az, ar]) => Math.hypot(x - ax, z - az) < ar)) continue;
    return [r2(x), r2(z)];
  }
  return null;
}

// ── Faults ───────────────────────────────────────────────────────────────────
// Each recipe either changes the context and returns true, or returns false when
// this layout cannot support it. Order is irrelevant: the caller shuffles.

// Swap a built-in fixture for its faulty counterpart (same position, same size).
function swapRecipe(models, to, category, label) {
  return (ctx) => {
    const target = Array.isArray(to) ? pick(to, ctx.rng) : to;
    // Prefer a fixture the replacement fits over; a layout where it fits nowhere
    // simply does not get this fault.
    const o = shuffled(
      ctx.objects.filter((x) => !x.added && !ctx.used.has(x.id) && models.includes(x.model)),
      ctx.rng
    ).find((x) => swapFits(ctx, x, target));
    if (!o) return false;
    o.model = target;
    o.defectId = category;
    o.label = label;
    ctx.used.add(o.id);
    return true;
  };
}

// Which local axis is a prop's long side. Props with no entry are roughly round
// (a plate, a bin, a heap), so any facing looks right for them.
const LONG_AXIS = { cleaningcart: 'x', divider: 'z' };

/**
 * A believable facing for an added prop. A long prop at a random angle reads as
 * dropped from a height; a person parks a cart square to the wall, or square to
 * the room. Near a wall the prop lies parallel to it; elsewhere it is squared to
 * the room axes. Both get a few degrees of jitter, so it is not CAD-perfect.
 */
function facingFor(ctx, model, [x, z]) {
  const long = LONG_AXIS[model];
  if (!long) return r2(ctx.rng() * Math.PI * 2);
  const { hw, hl } = roomHalf(ctx.plan, 0);
  const gapX = hw - Math.abs(x);
  const gapZ = hl - Math.abs(z);
  // A wall running along x is the nearer one when we are closer to the z edge.
  // Away from every wall, either orientation is as good as the other.
  const wallAlongX = Math.min(gapX, gapZ) <= 1.1 ? gapZ <= gapX : ctx.rng() < 0.5;
  // Local x is the long side at ry 0; it lies along world z after a quarter turn.
  const base = (long === 'x') === wallAlongX ? 0 : Math.PI / 2;
  const flip = ctx.rng() < 0.5 ? 0 : Math.PI;
  return r2(base + flip + (ctx.rng() - 0.5) * 0.12);
}

// Add a prop at a random free spot and tag it.
function addRecipe(models, category, label, { extra } = {}) {
  return (ctx) => {
    const model = pick(models, ctx.rng);
    const pos = findSpot(ctx);
    if (!pos) return false;
    const obj = {
      id: ctx.makeId(),
      added: true,
      model,
      pos,
      ry: facingFor(ctx, model, pos),
      defectId: category,
      label: label || labelFor(model),
    };
    ctx.objects.push(obj);
    ctx.used.add(obj.id);
    ctx.avoid.push([pos[0], pos[1], 0.9]);
    if (extra) extra(ctx, obj);
    return true;
  };
}

// The bench across the entrance route. On the lane ON PURPOSE, but never on top
// of furniture, and it carries no collision box so it cannot trap anyone.
function blockedPath(ctx) {
  const spawn = spawnOf(ctx.plan);
  const dx = 0 - spawn[0];
  const dz = 0 - spawn[1];
  if (!dx && !dz) return false;
  for (let i = 0; i < 12; i += 1) {
    const t = 0.35 + ctx.rng() * 0.3;
    const x = spawn[0] + dx * t;
    const z = spawn[1] + dz * t;
    if (insideBox(x, z, ctx.boxes, 0.2)) continue;
    const obj = {
      id: ctx.makeId(),
      added: true,
      model: 'divider',
      pos: [r2(x), r2(z)],
      // Turned across the route. The bench's long axis is its local z, hence the
      // quarter turn (the hand-authored fault used PI/2 for a route along z too).
      ry: r2(Math.atan2(-dx, -dz) + Math.PI / 2),
      defectId: 'blocked_path',
      label: 'Bench',
    };
    ctx.objects.push(obj);
    ctx.used.add(obj.id);
    ctx.avoid.push([obj.pos[0], obj.pos[1], 1.0]);
    return true;
  }
  return false;
}

// Cart plus a caddy of supplies beside it (the supplies are scenery, the cart is
// what gets tagged).
const cartRecipe = addRecipe(['cleaningcart'], 'lingering_equipment', 'Cleaning equipment', {
  extra(ctx, cart) {
    // Beside the cart along ITS long side, whichever way it was turned (a local
    // offset rotated by ry, as defects.js does for side-by-side props).
    const c = Math.cos(cart.ry);
    const sn = Math.sin(cart.ry);
    const pos = [r2(cart.pos[0] + 0.7 * c + 0.3 * sn), r2(cart.pos[1] - 0.7 * sn + 0.3 * c)];
    // The caddy has to obey the same rules as the cart it sits beside.
    const { hw, hl } = roomHalf(ctx.plan, 0.6);
    const spawn = spawnOf(ctx.plan);
    if (Math.abs(pos[0]) > hw || Math.abs(pos[1]) > hl) return;
    if (insideBox(pos[0], pos[1], ctx.boxes, 0.35)) return;
    if (Math.hypot(pos[0] - spawn[0], pos[1] - spawn[1]) < SPAWN_CLEAR) return;
    if (distToSegment(pos[0], pos[1], spawn, [0, 0]) < LANE_CLEAR) return;
    ctx.objects.push({
      id: ctx.makeId(),
      added: true,
      model: 'cleaningsupply',
      pos,
      ry: r2(ctx.rng() * Math.PI * 2),
    });
  },
});

// What they leave on a table or counter.
const LEFT_ON_SURFACE = ['dishes', 'canA', 'canB', 'toiletry'];

// Fixtures a small prop can stand on. The top is read from the same fit table the
// room renders with, so a can sits ON the coffee table and not through it.
const SURFACES = new Set(['coffee', 'desk', 'nightstand', 'sidetable']);

// Layouts stretch some "coffee tables" to counter height and beyond (a 1.3 m one
// is a bar). Only tabletop-range tops are used: something a guest left within reach.
const TOP_RANGE = [0.3, 1.05];

function surfaceHeight(o) {
  const cfg = MODEL_CFG[o.model] || {};
  const h = o.size?.[1] ?? o.h ?? cfg.size?.[1] ?? cfg.h;
  if (!h) return null;
  const top = (o.y ?? 0) + h * (o.scale?.[1] ?? 1);
  return top >= TOP_RANGE[0] && top <= TOP_RANGE[1] ? top : null;
}

/** A free tabletop: where to stand something and how high, or null. */
function findSurface(ctx) {
  const o = shuffled(
    ctx.objects.filter((x) => !x.added && SURFACES.has(x.model) && !ctx.surfaces.has(x.id) && surfaceHeight(x) !== null),
    ctx.rng
  )[0];
  if (!o) return null;
  ctx.surfaces.add(o.id);
  // A little off-centre along the table's own width, whichever way it faces.
  const ext = boxExtent(o);
  const reach = ext ? Math.min(0.25, ext[0] * 0.25) : 0;
  const d = (ctx.rng() * 2 - 1) * reach;
  const ry = o.ry || 0;
  return {
    pos: [r2(o.pos[0] + Math.cos(ry) * d), r2(o.pos[1] - Math.sin(ry) * d)],
    y: r2(surfaceHeight(o)),
  };
}

// Add a prop on a tabletop and tag it.
function surfaceRecipe(models, category, label) {
  return (ctx) => {
    const spot = findSurface(ctx);
    if (!spot) return false;
    const model = pick(models, ctx.rng);
    const obj = {
      id: ctx.makeId(),
      added: true,
      model,
      pos: spot.pos,
      y: spot.y,
      ry: r2(ctx.rng() * Math.PI * 2),
      defectId: category,
      label: label || labelFor(model),
    };
    ctx.objects.push(obj);
    ctx.used.add(obj.id);
    return true;
  };
}

// Harmless objects ADDED to the room, so a clean room is not just "the fixtures
// the layout already has". Floor pieces and tabletop pieces, none of them faults.
const DECOY_FLOOR_PROPS = [
  'pottedplant',
  'accentchair',
  'sidetable',
  'ottoman',
  'woodring',
  'woodring2',
  'playkitchen',
];
// (Not a towel: that is the amenity-count story, and a spare one would muddy it.)
const DECOY_TABLE_PROPS = ['orchid', 'desklamp'];

// One recipe per STORY, not per category: "a rat", "a dropped towel" and "dirty
// dishes" are all "not reset to standard", but a student should meet them as
// different things. `w` is the base weight; the draw below discounts whatever was
// used recently, so the same three faults do not come round every time.
const FAULT_RECIPES = [
  { key: 'bed', cat: 'lived_in', w: 1, run: swapRecipe(['bed', 'bedplain'], ['messybed', 'messybed2', 'dirtymattress'], 'lived_in', 'Bed linen') },
  { key: 'sofa', cat: 'lived_in', w: 1, run: swapRecipe(['sofa3'], 'unmadesofabed', 'lived_in', 'Sofa') },
  { key: 'toilet', cat: 'lived_in', w: 1, run: swapRecipe(['toilet'], 'dirtytoilet', 'lived_in', 'Toilet') },
  { key: 'sink', cat: 'lived_in', w: 1, run: swapRecipe(['vanity'], 'dirtysink', 'lived_in', 'Vanity') },
  { key: 'towels', cat: 'lived_in', w: 1, run: swapRecipe(['towelstack'], 'towelfloor', 'lived_in', 'Towels') },
  { key: 'minibar', cat: 'incomplete_stock', w: 1, run: swapRecipe(['minibar', 'fridgestocked'], 'fridgeempty', 'incomplete_stock', 'Minibar') },
  { key: 'cart', cat: 'lingering_equipment', w: 1, run: cartRecipe },
  { key: 'chemicals', cat: 'lingering_equipment', w: 1, run: addRecipe(['cleaningsupply'], 'lingering_equipment', 'Cleaning supplies') },
  // Left on the floor
  { key: 'dishes', cat: 'lived_in', w: 1, run: addRecipe(['dishes'], 'lived_in', null) },
  { key: 'trash', cat: 'lived_in', w: 1, run: addRecipe(['trashcan'], 'lived_in', null) },
  { key: 'pile', cat: 'lived_in', w: 1, run: addRecipe(['clutterpile'], 'lived_in', null) },
  { key: 'cans', cat: 'lived_in', w: 1, run: addRecipe(['canA', 'canB'], 'lived_in', null) },
  { key: 'pest', cat: 'lived_in', w: 0.7, run: addRecipe(['rat'], 'lived_in', null) },
  { key: 'dropped_towel', cat: 'lived_in', w: 1, run: addRecipe(['towelfloor'], 'lived_in', null) },
  // …and left on a table or counter
  { key: 'tabletop', cat: 'lived_in', w: 1.3, run: surfaceRecipe(LEFT_ON_SURFACE, 'lived_in') },
  { key: 'blocked', cat: 'blocked_path', w: 0.9, run: blockedPath },
];

// A fault that only counts when the real booking has the right party. Offered
// only on request: against a booking that does not fit, the game quietly turns
// it into a decoy (see supportedBy in scenario.js), which would leave the author
// with fewer faults than the button promised.
const BOOKING_RECIPES = [
  { key: 'amenity', cat: 'amenity_math', w: 1, run: swapRecipe(['towelstack'], 'towel', 'amenity_math', 'Towels') },
];

// Clean fixtures worth leaving as decoys: things a student would plausibly
// suspect. Matched on the model, or the procedural `type` for older fixtures.
const DECOY_MODELS = new Set([
  'wardrobe',
  'nightstand',
  'desk',
  'officechair',
  'chair',
  'armchair',
  'sofa3',
  'coffee',
  'tv',
  'toilet',
  'vanity',
  'tub',
  'minibar',
  'bed',
  'bookshelf',
  'towelrack',
  'shower',
]);
const DECOY_TYPES = new Set(['desk', 'tv', 'twinvanity']);

const titleCase = (s) => s.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

/**
 * Build a random scenario for a tier.
 *
 * @param {object}   args
 * @param {object}   args.plan         the tier's CURRENT layout (getRoomPlan)
 * @param {Array}    args.baseObjects  the editor's seed objects for that layout
 * @param {function} args.makeId       mints ids for added objects
 * @param {number}   [args.seed]
 * @param {'easy'|'medium'|'hard'} [args.level]
 * @param {boolean}  [args.includeBookingFaults]
 * @param {string[][]} [args.recent]  `keys` of the previous rolls, newest first; whatever
 *                                    they used is made less likely this time
 * @returns {{objects: Array, seed: number, faults: number, decoys: number, wanted: number, keys: string[]}}
 */
export function generateRandomScenario({
  plan,
  baseObjects,
  makeId,
  seed = newSeed(),
  level = 'medium',
  includeBookingFaults = false,
  recent = [],
}) {
  const want = LEVELS[level] || LEVELS.medium;
  const rng = makeRng(seed);
  // Copies, so the caller's seed objects are never mutated.
  const objects = baseObjects.map((o) => ({
    ...o,
    pos: [...o.pos],
    defectId: undefined,
    label: undefined,
  }));
  const ctx = {
    rng,
    plan,
    objects,
    boxes: solidBoxes(plan),
    avoid: [],
    used: new Set(),
    surfaces: new Set(),
    makeId,
  };

  // A weighted draw, not a fixed order. A recipe is less likely when its category
  // is already told (so a roll covers several different stories) and much less
  // likely when it ran in the last roll or two (so consecutive rolls differ). Both
  // are discounts, never bans: a small room that can only tell one story still
  // tells it.
  const pool = includeBookingFaults ? [...FAULT_RECIPES, ...BOOKING_RECIPES] : [...FAULT_RECIPES];
  const history = recent.map((r) => new Set(r));
  const fade = (key) => {
    const i = history.findIndex((h) => h.has(key));
    return i === -1 ? 1 : [0.08, 0.35][i] ?? 0.7;
  };
  let faults = 0;
  const keys = [];
  const cats = new Set();
  while (faults < want.faults && pool.length) {
    const weights = pool.map((r) => r.w * (cats.has(r.cat) ? 0.3 : 1) * fade(r.key));
    const i = weightedIndex(weights, rng);
    const [r] = pool.splice(i, 1);
    if (r.run(ctx)) {
      keys.push(r.key);
      cats.add(r.cat);
      faults += 1;
    }
  }

  // Decoys: clean fixtures left exactly as the layout has them, labelled by what
  // they are — never by their condition, which would give the answer away.
  // Whatever was a decoy last time goes to the back of the queue (a stable sort, so
  // the shuffle still decides among equals).
  const lastTime = history[0] || new Set();
  const staleLast = (key) => (lastTime.has(key) ? 1 : 0);
  const decoyPool = shuffled(
    objects.filter(
      (o) =>
        !o.added &&
        !ctx.used.has(o.id) &&
        ((o.model && DECOY_MODELS.has(o.model)) || (!o.model && o.type && DECOY_TYPES.has(o.type)))
    ),
    rng
  ).sort((a, b) => staleLast(`decoy:${a.model || a.type}`) - staleLast(`decoy:${b.model || b.type}`));
  // One decoy per distinct kind, so three nightstands do not crowd out a wardrobe.
  const kinds = new Set();
  let decoys = 0;
  for (const o of decoyPool) {
    if (decoys >= want.decoys) break;
    const kind = o.model || o.type;
    if (kinds.has(kind)) continue;
    kinds.add(kind);
    keys.push(`decoy:${kind}`);
    o.defectId = null;
    o.label = o.model ? labelFor(o.model).replace(/^./, (c) => c.toUpperCase()) : titleCase(o.type);
    decoys += 1;
  }

  // Added decoys: clean props that were never part of the layout. Labelled by what
  // they are, tagged as "not a fault", and placed by the same rules as a fault.
  let props = 0;
  for (const model of shuffled([...DECOY_FLOOR_PROPS, ...DECOY_TABLE_PROPS], rng).sort(
    (a, b) => staleLast(`decoy:${a}`) - staleLast(`decoy:${b}`)
  )) {
    if (props >= want.props) break;
    let pos;
    let y;
    if (DECOY_TABLE_PROPS.includes(model)) {
      const spot = findSurface(ctx);
      if (!spot) continue;
      pos = spot.pos;
      y = spot.y;
    } else {
      pos = findSpot(ctx);
      if (!pos) continue;
      ctx.avoid.push([pos[0], pos[1], 0.9]);
    }
    objects.push({
      id: makeId(),
      added: true,
      model,
      pos,
      ...(y !== undefined ? { y } : {}),
      ry: r2(rng() * Math.PI * 2),
      defectId: null,
      label: labelFor(model).replace(/^./, (c) => c.toUpperCase()),
    });
    keys.push(`decoy:${model}`);
    props += 1;
    decoys += 1;
  }

  return { objects, seed, faults, decoys, wanted: want.faults, keys };
}

// ─────────────────────────────────────────────────────────────────────────────
// Play-time safety net.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check the objects a scenario ADDED against the layout as it is NOW.
 *
 * A scenario stores coordinates; the layout can be edited afterwards. A prop that
 * was in clear floor when saved may now be inside a wardrobe, or outside a room
 * that got smaller. Such a prop is nudged to the nearest clear spot, or dropped
 * if there is none — and the caller is told, so nothing changes silently.
 *
 * Deliberately conservative, because authors place things by hand on purpose:
 *   • only a prop whose CENTRE is strictly inside a solid box (or outside the
 *     room) counts as broken — standing next to furniture is fine;
 *   • raised props (`y` > 0: on a table, on a shelf) are left alone, since they
 *     are meant to be "inside" the footprint of what carries them;
 *   • the blocked-walkway fault is exempt, it is supposed to be in the way.
 *
 * @param {Array} added   scenario.added
 * @param {object} plan   the tier layout, as it is now
 * @param {Array} [tags]  scenario.tags
 * @returns {{added: Array, moved: string[], dropped: string[]}}
 */
export function fitAddedToLayout(added, plan, tags = []) {
  if (!Array.isArray(added) || !added.length || !plan) return { added: added || [], moved: [], dropped: [] };
  const boxes = solidBoxes(plan);
  const { hw, hl } = roomHalf(plan, 0.1);
  const exempt = new Set((tags || []).filter((t) => t.defectId === 'blocked_path').map((t) => t.ref));

  const broken = (x, z) => Math.abs(x) > hw || Math.abs(z) > hl || insideBox(x, z, boxes, 0);
  const roomy = (x, z) => Math.abs(x) <= hw - 0.3 && Math.abs(z) <= hl - 0.3 && !insideBox(x, z, boxes, 0.3);

  const out = [];
  const moved = [];
  const dropped = [];
  for (const a of added) {
    const pos = Array.isArray(a.pos) ? a.pos : null;
    const raised = Number(a.y) > 0.05;
    if (!pos || raised || exempt.has(a.id) || !broken(pos[0], pos[1])) {
      out.push(a);
      continue;
    }
    let spot = null;
    for (let r = 0.3; r <= 2.0 && !spot; r += 0.25) {
      for (let k = 0; k < 12; k += 1) {
        const ang = (k / 12) * Math.PI * 2;
        const x = pos[0] + Math.cos(ang) * r;
        const z = pos[1] + Math.sin(ang) * r;
        if (roomy(x, z)) {
          spot = [r2(x), r2(z)];
          break;
        }
      }
    }
    if (spot) {
      out.push({ ...a, pos: spot });
      moved.push(a.id);
    } else {
      dropped.push(a.id);
    }
  }
  return { added: out, moved, dropped };
}
