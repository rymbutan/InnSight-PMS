// Deterministic layout guard for the housekeeping sim — 2D gameplay AND 3D geometry.
//
// PART 1 — GAMEPLAY (2D). Replicates RoomFreeRoam's collision model (furniture/wall
// footprints inflated by 0.25 m per side), movement bounds (±(dim/2 − 0.45)) and
// station activation radius (2.4 m), then verifies that each cleaning station:
//   • is REACHABLE from the spawn (BFS over free floor — catches walled-off /
//     boxed-in stations and un-enterable bathrooms),
//   • is not BURIED (its ring center isn't inside a collision box),
//   • is ADJACENT to the furniture its task represents (≤0.9 m).
// It also flags furniture overlaps, out-of-bounds furniture, and stations too
// close to disambiguate.
//
// PART 2 — GEOMETRY (3D). This half is new, and it exists because the 2D half
// printed "✅ ALL TIERS CLEAN" on a room that had a 4.8 m tall rug, a bathtub
// passing through a wall, a toilet inside a wall, a wardrobe rotated 90° out, and
// a 3.16 m slat screen the player walked straight through. None of that is visible
// to a footprint check. It now verifies:
//   • RENDERED height fits under the ceiling and sits on the floor,
//   • collision `box` matches the rendered footprint (the visual and the wall you
//     bump into must be the same object),
//   • fixtures staged against a wall are actually AGAINST it, not floating,
//   • fixtures don't intersect the room shell or an interior wall,
//   • wall-mounted / on-surface items have a sane `y`,
//   • no two fixtures sit at the same coordinates (duplicate lamps, doubled mirrors).
//
// Rendered sizes come from web/src/sim/modelSizes.js applied to the measured native
// dimensions in scripts/model-metrics.json — the same math task3d.jsx uses, so this
// reasons about what actually renders rather than what the layout claims.
//
// Run: node scripts/check-room-layouts.mjs
//      node scripts/check-room-layouts.mjs --warn-only   (report, exit 0)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const simDir = join(here, '..', 'web', 'src', 'sim');
const { LAYOUTS, FOOTPRINTS } = await import(new URL('file://' + join(simDir, 'roomLayouts.js')).href);
const { MODEL_FILES, renderedSize, TYPE_EXTENTS } = await import(new URL('file://' + join(simDir, 'modelSizes.js')).href);
const METRICS = JSON.parse(readFileSync(join(here, 'model-metrics.json'), 'utf8')).models;

const WARN_ONLY = process.argv.includes('--warn-only');
// --sizes prints the RENDERED extent of every fixture, which is what you need in
// order to place something flush against a wall (pos = ±(dim/2 − depth/2)).
const SHOW_SIZES = process.argv.includes('--sizes');

const INFLATE = 0.25;   // collision inflation per side (blocked())
const MARGIN = 0.45;    // movement clamp margin from each wall
const ACT = 2.4;        // station activation radius
const STEP = 0.1;       // BFS grid resolution (m)
const NEAR = 0.9;       // max station→target-furniture distance (m) — ring must HUG its fixture

// 3D tolerances
const WALL_GAP = 0.18;  // a fixture "against a wall" may sit at most this far off it
const CLIP = 0.05;      // intersections deeper than this are real, not float noise
const BOX_SLOP = 0.35;  // allowed collision-box vs rendered-footprint difference
const DUP_DIST = 0.05;  // two fixtures closer than this are duplicates

// ── rendered extents ────────────────────────────────────────────────────────
// [width(x), height(y), depth(z)] of a fixture as it actually renders, BEFORE ry.
function extentOf(it) {
  if (it.model) {
    const native = METRICS[MODEL_FILES[it.model]];
    if (!native) return null;              // unknown model — reported separately
    const s = renderedSize(it, native);
    return s && [s[0], s[1], s[2]];
  }
  if (it.type) {
    const f = FOOTPRINTS[it.type];
    const e = TYPE_EXTENTS[it.type];
    // `rug`, `drape` and `panel` carry their own explicit span in `s`.
    if (it.s && (it.type === 'rug' || it.type === 'drape' || it.type === 'panel')) {
      const h = it.type === 'rug' ? (e?.h ?? 0.012) : it.s[1];
      return it.type === 'rug' ? [it.s[0], h, it.s[1]] : [it.s[0], h, 0.08];
    }
    if (!f) return null;
    return [f[0], e?.h ?? 0, f[1]];
  }
  return null;
}
// Footprint after applying a ~90° rotation, matching blockersOf().
function rotated(w, d, ry) {
  if (!ry) return [w, d];
  const a = Math.abs(((ry % Math.PI) + Math.PI) % Math.PI - Math.PI / 2);
  return a < 0.5 ? [d, w] : [w, d];
}
function renderRect(it) {
  const e = extentOf(it);
  if (!e) return null;
  let [w, , d] = e;
  if (it.scale) { w *= it.scale[0]; d *= it.scale[2]; }
  [w, d] = rotated(w, d, it.ry);
  return [it.pos[0] - w / 2, it.pos[0] + w / 2, it.pos[1] - d / 2, it.pos[1] + d / 2];
}

function footprintOf(it) {
  let w, d;
  if (it.box) { [w, d] = it.box; }
  else if (it.type) { const f = FOOTPRINTS[it.type]; if (!f || !f[2]) return null; [w, d] = f; }
  else return null;
  if (it.scale) { w *= it.scale[0]; d *= it.scale[2]; }
  [w, d] = rotated(w, d, it.ry);
  return [it.pos[0] - w / 2, it.pos[0] + w / 2, it.pos[1] - d / 2, it.pos[1] + d / 2];
}
function wallRects(walls) {
  return (walls || []).map(({ p, w, d, ry }) => {
    const [W, D] = rotated(w, d, ry);
    return [p[0] - W / 2, p[0] + W / 2, p[1] - D / 2, p[1] + D / 2];
  });
}
const blockedBy = (x, z, r) => x > r[0] - INFLATE && x < r[1] + INFLATE && z > r[2] - INFLATE && z < r[3] + INFLATE;
const blocked = (x, z, rects) => rects.some((r) => blockedBy(x, z, r));
function distToRect(x, z, [a, b, c, d]) {
  const dx = Math.max(a - x, 0, x - b), dz = Math.max(c - z, 0, z - d);
  return Math.hypot(dx, dz);
}
const overlap = (a, b) => [
  Math.min(a[1], b[1]) - Math.max(a[0], b[0]),
  Math.min(a[3], b[3]) - Math.max(a[2], b[2]),
];
// Separation between two rects: 0 if they touch or overlap.
function rectGap(a, b) {
  const [ox, oz] = overlap(a, b);
  return Math.hypot(Math.max(0, -ox), Math.max(0, -oz));
}
const label = (it) => `${it.type || it.model}@[${it.pos}]`;

// Fixtures that belong flush against a wall. Case goods and plumbing only —
// freestanding lounge pieces, rugs, and anything that sits on another surface are
// deliberately excluded.
const AGAINST_WALL = new Set([
  'bed', 'twin', 'nightstand', 'wardrobe', 'walkin', 'bookshelf',
  'sofa', 'sofa3', 'console', 'desk', 'tv', 'minibar', 'wetbar', 'counter',
  'vanity', 'twinvanity', 'tub', 'deckTub', 'toilet', 'shower', 'towelrack',
]);

// taskType → furniture types the station should sit beside (null = no target).
const TARGET = {
  bed: ['bed'], turndown: ['bed'], linen: ['bed'],
  bath: ['tub', 'toilet', 'vanity', 'twinvanity', 'deckTub', 'shower'],
  bath2: ['tub', 'toilet', 'vanity', 'twinvanity', 'deckTub', 'shower'],
  minibar: ['minibar'], wetbar: ['wetbar', 'minibar'], dining: ['dining', 'desk'],
  balcony: ['drape', 'curtain', 'city', 'window'],
  // floor / flexible tasks — placed in open zones, not hugging one fixture:
  livingvac: null, amenity: null, ac: null, vacuum: null, inspect: null,
};

let totalProblems = 0;
for (const [name, L] of Object.entries(LAYOUTS)) {
  const problems = [];
  const H = L.h ?? 3;
  const furn = L.furniture.filter((it) => footprintOf(it));
  const furnRects = furn.map(footprintOf);
  const walls = wallRects(L.walls);
  const rects = [...furnRects, ...walls];
  const hw = L.w / 2 - MARGIN, hl = L.l / 2 - MARGIN;

  // ── PART 1: gameplay (2D) ────────────────────────────────────────────────
  furn.forEach((it, k) => {
    const r = furnRects[k];
    if (r[0] < -L.w / 2 - 1e-6 || r[1] > L.w / 2 + 1e-6 || r[2] < -L.l / 2 - 1e-6 || r[3] > L.l / 2 + 1e-6)
      problems.push(`OUT-OF-BOUNDS ${label(it)}`);
  });
  for (let i = 0; i < furnRects.length; i++) for (let j = i + 1; j < furnRects.length; j++) {
    const [ox, oz] = overlap(furnRects[i], furnRects[j]);
    if (ox > 0.05 && oz > 0.05)
      problems.push(`FURNITURE OVERLAP ${label(furn[i])} ∩ ${label(furn[j])} (${ox.toFixed(2)}×${oz.toFixed(2)}m)`);
  }

  const nx = Math.round((2 * hw) / STEP) + 1, nz = Math.round((2 * hl) / STEP) + 1;
  const idx = (i, j) => i * nz + j;
  const free = new Uint8Array(nx * nz);
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++)
    free[idx(i, j)] = blocked(-hw + i * STEP, -hl + j * STEP, rects) ? 0 : 1;
  const si = Math.round((L.spawn[0] + hw) / STEP), sj = Math.round((L.spawn[1] + hl) / STEP);
  const reach = new Uint8Array(nx * nz);
  const spawnFree = si >= 0 && si < nx && sj >= 0 && sj < nz && free[idx(si, sj)];
  if (!spawnFree) problems.push(`SPAWN blocked @[${L.spawn}]`);
  const q = spawnFree ? [[si, sj]] : [];
  if (spawnFree) reach[idx(si, sj)] = 1;
  while (q.length) {
    const [i, j] = q.pop();
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz || reach[idx(ni, nj)] || !free[idx(ni, nj)]) continue;
      reach[idx(ni, nj)] = 1; q.push([ni, nj]);
    }
  }

  L.stations.forEach((s) => {
    const [sx, sz] = s.pos;
    if (blocked(sx, sz, rects)) problems.push(`BURIED station "${s.title}" @[${sx},${sz}] — ring inside a collision box`);
    let reachable = false;
    const r0i = Math.max(0, Math.floor((sx - ACT + hw) / STEP)), r1i = Math.min(nx - 1, Math.ceil((sx + ACT + hw) / STEP));
    const r0j = Math.max(0, Math.floor((sz - ACT + hl) / STEP)), r1j = Math.min(nz - 1, Math.ceil((sz + ACT + hl) / STEP));
    for (let i = r0i; i <= r1i && !reachable; i++) for (let j = r0j; j <= r1j; j++) {
      if (!reach[idx(i, j)]) continue;
      if (Math.hypot(-hw + i * STEP - sx, -hl + j * STEP - sz) <= ACT) { reachable = true; break; }
    }
    if (!reachable) problems.push(`UNREACHABLE station "${s.title}" @[${sx},${sz}] — no reachable floor within ${ACT}m`);

    // Adjacency now applies to EVERY tier. It used to be skipped entirely for
    // Presidential (`name === 'Presidential' ? null`), which is exactly how a
    // "Wet Bar" station ended up as a glowing ring on bare floor with no wet bar
    // fixture anywhere near it.
    const targets = TARGET[s.taskType];
    if (targets) {
      const cand = L.furniture.filter((f) => targets.includes(f.type) || targets.includes(f.model));
      if (!cand.length) problems.push(`NO TARGET furniture (${targets.join('/')}) for station "${s.title}"`);
      else {
        const dmin = Math.min(...cand.map((f) => {
          const r = footprintOf(f) || renderRect(f);
          return r ? distToRect(sx, sz, r) : Infinity;
        }));
        if (dmin > NEAR) problems.push(`FAR station "${s.title}" — ${dmin.toFixed(2)}m from nearest ${targets.join('/')} (want ≤${NEAR}m)`);
      }
    }
  });

  for (let i = 0; i < L.stations.length; i++) for (let j = i + 1; j < L.stations.length; j++) {
    const a = L.stations[i].pos, b = L.stations[j].pos;
    const dd = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (dd < NEAR) problems.push(`STATIONS TOO CLOSE "${L.stations[i].title}" ↔ "${L.stations[j].title}" (${dd.toFixed(2)}m)`);
  }

  // ── PART 2: geometry (3D) ────────────────────────────────────────────────
  L.furniture.forEach((it) => {
    const e = extentOf(it);
    if (it.model && !METRICS[MODEL_FILES[it.model]]) {
      problems.push(`UNKNOWN MODEL "${it.model}" ${label(it)} — not in model-metrics.json`);
      return;
    }
    if (!e) return;
    const [ew, eh, ed] = e;
    const y = it.y ?? 0;
    const sy = it.scale ? it.scale[1] : 1;
    const h = eh * sy;

    // Vertical fit. `wall`/anchorY:'center' items are centered on y, everything
    // else has its base at y.
    const top = it.wall ? y + h / 2 : y + h;
    const bottom = it.wall ? y - h / 2 : y;
    if (top > H + 1e-6) problems.push(`CEILING CLIP ${label(it)} — top ${top.toFixed(2)}m vs ceiling ${H}m (renders ${h.toFixed(2)}m tall)`);
    if (bottom < -1e-6) problems.push(`FLOOR CLIP ${label(it)} — base ${bottom.toFixed(2)}m below the floor`);
    // Something taller than the room it's in is always a scaling bug.
    if (h > H) problems.push(`OVERSIZED ${label(it)} — renders ${h.toFixed(2)}m tall in a ${H}m room`);

    // Collision box vs what you can see. A mismatch means you either walk through
    // the visual or bump into thin air.
    if (it.box) {
      const [bw, bd] = rotated(it.box[0], it.box[1], it.ry);
      const [rw, rd] = rotated(ew, ed, it.ry);
      const dw = Math.abs(bw - rw), dd2 = Math.abs(bd - rd);
      if (dw > BOX_SLOP || dd2 > BOX_SLOP)
        problems.push(`BOX≠VISUAL ${label(it)} — collision ${bw.toFixed(2)}×${bd.toFixed(2)} vs rendered ${rw.toFixed(2)}×${rd.toFixed(2)}`);
    } else if (it.model && h > 0.5 && !it.wall && (it.y ?? 0) === 0) {
      // A floor-standing model of real size with no `box` is walk-through-able.
      problems.push(`NO COLLISION ${label(it)} — floor-standing model ${h.toFixed(2)}m tall with no box`);
    }

    // Interior-wall intersection, using the RENDERED footprint (not the box).
    const rr = renderRect(it);
    if (rr && !it.wall) {
      walls.forEach((wr, wi) => {
        const [ox, oz] = overlap(rr, wr);
        if (ox > CLIP && oz > CLIP)
          problems.push(`WALL CLIP ${label(it)} passes ${Math.min(ox, oz).toFixed(2)}m into interior wall #${wi}`);
      });
      // Room shell.
      const over = Math.max(-L.w / 2 - rr[0], rr[1] - L.w / 2, -L.l / 2 - rr[2], rr[3] - L.l / 2);
      if (over > CLIP) problems.push(`SHELL CLIP ${label(it)} extends ${over.toFixed(2)}m outside the room`);
    }

    // "Against a wall" check.
    //
    // Only case goods count. A lamp on a nightstand, a corner plant or a pouf is
    // not "staged against" anything, and flagging those buried the real findings in
    // noise. And only the NEAREST wall counts: a nightstand in a back corner is
    // against the back wall, not simultaneously failing to touch the side wall.
    if (rr && !it.wall && AGAINST_WALL.has(it.type || it.model)) {
      // Clamp at 0 rather than requiring g >= 0: a fixture placed exactly flush can
      // land a fraction of a millimetre proud of the wall through float rounding,
      // and discarding that side then matched the fixture against some FARTHER wall
      // and reported a 65cm gap for something that was already touching.
      const sides = [
        ['back (−z)', rr[2] - (-L.l / 2)], ['front (+z)', L.l / 2 - rr[3]],
        ['left (−x)', rr[0] - (-L.w / 2)], ['right (+x)', L.w / 2 - rr[1]],
      ].filter(([, g]) => g > -0.03 && g < 1.0)
        .map(([side, g]) => [side, Math.max(0, g)])
        .sort((a, b) => a[1] - b[1]);
      // INTERIOR walls count too. A bathroom vanity flush against the enclosure's
      // own wall is correctly placed even though it is half a metre from the
      // nearest room wall — only complain if it is flush against NOTHING.
      const interior = walls.map((wr) => rectGap(rr, wr)).filter((g) => g < 1.0);
      const best = Math.min(
        sides.length ? sides[0][1] : Infinity,
        interior.length ? Math.min(...interior) : Infinity,
      );
      if (Number.isFinite(best) && best > WALL_GAP) {
        const side = sides.length && sides[0][1] === best ? sides[0][0] : 'nearest';
        problems.push(`WALL GAP ${label(it)} — ${(best * 100).toFixed(0)}cm off the ${side} wall it is staged against`);
      }
    }

    // Wall-mounted things need a mounting height; on-surface things need to be
    // above the floor.
    if (it.wall && !it.y) problems.push(`NO MOUNT HEIGHT ${label(it)} — wall:true with no y`);
  });

  // Duplicate placements — doubled lamps z-fight and double their pointLight,
  // and a mirror on top of a vanity's own integral mirror reads as two mirrors.
  for (let i = 0; i < L.furniture.length; i++) for (let j = i + 1; j < L.furniture.length; j++) {
    const a = L.furniture[i], b = L.furniture[j];
    if ((a.type || a.model) !== (b.type || b.model)) continue;
    if (Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]) < DUP_DIST && (a.y ?? 0) === (b.y ?? 0))
      problems.push(`DUPLICATE ${label(a)} placed twice at the same spot`);
  }

  totalProblems += problems.length;
  console.log(`\n=== ${name} (${L.w}×${L.l}×${H}, ${L.stations.length} stations, ${L.furniture.length} fixtures) ===`);

  if (SHOW_SIZES) {
    console.log(`  ${'fixture'.padEnd(16)} ${'pos'.padEnd(16)} ${'rendered w×h×d'.padEnd(22)} flush-at`);
    for (const it of L.furniture) {
      const e = extentOf(it);
      if (!e) { console.log(`  ${String(it.type || it.model).padEnd(16)} ${`[${it.pos}]`.padEnd(16)} (no extent)`); continue; }
      const [w, h, d] = e;
      const [rw, rd] = rotated(w, d, it.ry);
      // Where its centre must go for its back face to touch each wall.
      const fl = (-L.w / 2 + rw / 2).toFixed(2), fr = (L.w / 2 - rw / 2).toFixed(2);
      const fb = (-L.l / 2 + rd / 2).toFixed(2), ff = (L.l / 2 - rd / 2).toFixed(2);
      console.log(`  ${String(it.type || it.model).padEnd(16)} ${`[${it.pos}]`.padEnd(16)} ${`${w.toFixed(2)}×${h.toFixed(2)}×${d.toFixed(2)}`.padEnd(22)} x:${fl}/${fr} z:${fb}/${ff}`);
    }
    console.log('');
  }
  if (!problems.length) console.log('  ✓ clean — gameplay reachable AND geometry fits');
  else problems.forEach((p) => console.log('  ✗ ' + p));
}
console.log(`\n${totalProblems === 0 ? '✅ ALL TIERS CLEAN' : (WARN_ONLY ? '⚠️  ' : '❌ ') + totalProblems + ' problem(s) found'}`);
process.exit(totalProblems === 0 || WARN_ONLY ? 0 : 1);
