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

/** How many faults / decoys each difficulty aims for. A layout may allow fewer. */
export const LEVELS = {
  easy: { label: 'Easy', faults: 2, decoys: 3 },
  medium: { label: 'Medium', faults: 4, decoys: 4 },
  hard: { label: 'Hard', faults: 6, decoys: 5 },
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

const baseWith = (ctx, test) =>
  shuffled(
    ctx.objects.filter((o) => !o.added && !ctx.used.has(o.id) && test(o)),
    ctx.rng
  )[0] || null;

// Swap a built-in fixture for its faulty counterpart (same position, same size).
function swapRecipe(models, to, category, label) {
  return (ctx) => {
    const o = baseWith(ctx, (x) => models.includes(x.model));
    if (!o) return false;
    o.model = Array.isArray(to) ? pick(to, ctx.rng) : to;
    o.defectId = category;
    o.label = label;
    ctx.used.add(o.id);
    return true;
  };
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
      ry: r2(ctx.rng() * Math.PI * 2),
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
    const pos = [r2(cart.pos[0] + 0.7), r2(cart.pos[1] + 0.3)];
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

const FAULT_RECIPES = [
  {
    key: 'bed',
    cat: 'lived_in',
    run: swapRecipe(['bed', 'bedplain'], ['messybed', 'messybed2'], 'lived_in', 'Bed linen'),
  },
  { key: 'sofa', cat: 'lived_in', run: swapRecipe(['sofa3'], 'unmadesofabed', 'lived_in', 'Sofa') },
  { key: 'toilet', cat: 'lived_in', run: swapRecipe(['toilet'], 'dirtytoilet', 'lived_in', 'Toilet') },
  { key: 'sink', cat: 'lived_in', run: swapRecipe(['vanity'], 'dirtysink', 'lived_in', 'Vanity') },
  { key: 'towels', cat: 'lived_in', run: swapRecipe(['towelstack'], 'towelfloor', 'lived_in', 'Towels') },
  {
    key: 'minibar',
    cat: 'incomplete_stock',
    run: swapRecipe(['minibar', 'fridgestocked'], 'fridgeempty', 'incomplete_stock', 'Minibar'),
  },
  { key: 'cart', cat: 'lingering_equipment', run: cartRecipe },
  {
    key: 'clutter',
    cat: 'lived_in',
    run: addRecipe(['dishes', 'trashcan', 'clutterpile'], 'lived_in', null),
  },
  { key: 'blocked', cat: 'blocked_path', run: blockedPath },
];

// A fault that only counts when the real booking has the right party. Offered
// only on request: against a booking that does not fit, the game quietly turns
// it into a decoy (see supportedBy in scenario.js), which would leave the author
// with fewer faults than the button promised.
const BOOKING_RECIPES = [
  { key: 'amenity', cat: 'amenity_math', run: swapRecipe(['towelstack'], 'towel', 'amenity_math', 'Towels') },
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
 * @returns {{objects: Array, seed: number, faults: number, decoys: number, wanted: number}}
 */
export function generateRandomScenario({
  plan,
  baseObjects,
  makeId,
  seed = newSeed(),
  level = 'medium',
  includeBookingFaults = false,
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
    makeId,
  };

  const recipes = shuffled(
    includeBookingFaults ? [...FAULT_RECIPES, ...BOOKING_RECIPES] : FAULT_RECIPES,
    rng
  );
  // Two passes, so a roll tells several different stories: first at most one
  // fault per category, then — only if the layout still has room for more — the
  // rest. Without the first pass, "not reset to standard" (bed, toilet, sink,
  // towels, clutter) swamps everything else.
  let faults = 0;
  const done = new Set();
  const cats = new Set();
  for (const pass of [1, 2]) {
    for (const r of recipes) {
      if (faults >= want.faults) break;
      if (done.has(r.key) || (pass === 1 && cats.has(r.cat))) continue;
      if (r.run(ctx)) {
        done.add(r.key);
        cats.add(r.cat);
        faults += 1;
      }
    }
  }

  // Decoys: clean fixtures left exactly as the layout has them, labelled by what
  // they are — never by their condition, which would give the answer away.
  const decoyPool = shuffled(
    objects.filter(
      (o) =>
        !o.added &&
        !ctx.used.has(o.id) &&
        ((o.model && DECOY_MODELS.has(o.model)) || (!o.model && o.type && DECOY_TYPES.has(o.type)))
    ),
    rng
  );
  // One decoy per distinct kind, so three nightstands do not crowd out a wardrobe.
  const kinds = new Set();
  let decoys = 0;
  for (const o of decoyPool) {
    if (decoys >= want.decoys) break;
    const kind = o.model || o.type;
    if (kinds.has(kind)) continue;
    kinds.add(kind);
    o.defectId = null;
    o.label = o.model ? labelFor(o.model).replace(/^./, (c) => c.toUpperCase()) : titleCase(o.type);
    decoys += 1;
  }

  return { objects, seed, faults, decoys, wanted: want.faults };
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
