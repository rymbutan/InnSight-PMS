// ─────────────────────────────────────────────────────────────────────────────
// Walk-collision for the 3D room. Extracted from RoomFreeRoam.jsx so it can be
// tested: that file imports three.js and drei, so nothing inside it can be
// loaded by `node --test`, and the rule deciding whether a student can move had
// no coverage at all.
//
// Collision is OPT-IN. A fixture is solid only if it declares a `box` (model
// fixtures) or its FOOTPRINTS entry is flagged solid (procedural `type`
// fixtures). Everything else — wall art, drapes, ceiling fittings, on-surface
// items and every scenario prop — is walk-through. That is deliberate: about
// half the fixtures in a room are decor, and a student inspecting a room should
// be able to get close to what they are judging.
// ─────────────────────────────────────────────────────────────────────────────

import { FOOTPRINTS } from './roomLayouts.js';

/** Personal-space margin around every solid box, in metres. */
export const PAD = 0.25;

/**
 * Solid axis-aligned boxes for a furniture list.
 * @returns {Array<[minX, maxX, minZ, maxZ, label]>}
 */
export function blockersOf(furniture) {
  const out = [];
  (furniture || []).forEach((it) => {
    let w;
    let d;
    if (it.box) {
      [w, d] = it.box; // model fixtures: explicit collision box
    } else if (it.type) {
      const f = FOOTPRINTS[it.type];
      if (!f || !f[2]) return; // procedural fixture flagged non-solid
      [w, d] = f;
    } else {
      return; // model fixture with no box, or a scenario prop: walk-through
    }
    if (it.scale) {
      w *= it.scale[0];
      d *= it.scale[2];
    } // honour editor resize so collision matches the visual
    // ~90° rotated fixtures swap their footprint axes so collision still fits.
    if (it.ry) {
      const a = Math.abs((((it.ry % Math.PI) + Math.PI) % Math.PI) - Math.PI / 2);
      if (a < 0.5) [w, d] = [d, w];
    }
    out.push([
      it.pos[0] - w / 2,
      it.pos[0] + w / 2,
      it.pos[1] - d / 2,
      it.pos[1] + d / 2,
      it.model || it.type,
    ]);
  });
  return out;
}

export function wallBlockers(walls) {
  return (walls || []).map(({ p, w, d, ry }) => {
    let W = w;
    let D = d;
    if (ry) {
      const a = Math.abs((((ry % Math.PI) + Math.PI) % Math.PI) - Math.PI / 2);
      if (a < 0.5) [W, D] = [D, W];
    } // ~90° walls swap footprint
    return [p[0] - W / 2, p[0] + W / 2, p[1] - D / 2, p[1] + D / 2, 'wall'];
  });
}

export function blocked(x, z, blockers) {
  return (blockers || []).some(([a, b, c, d]) => x > a - PAD && x < b + PAD && z > c - PAD && z < d + PAD);
}

/**
 * Resolve one step of movement, axis by axis so a player slides along a fixture
 * rather than sticking to it.
 *
 * THE ESCAPE RULE. If the player is ALREADY inside a solid box, the move is
 * allowed regardless. Without it the room is a trap: every candidate position
 * inside the box is blocked too, so once a student ends up inside a sofa — by a
 * mis-sized collision box, a layout edit, or a scenario that placed something on
 * top of them — they can never walk out and the shift is unrecoverable. Being
 * able to walk out of geometry you should not be in is strictly better than
 * being stuck in it.
 *
 * @param {[number, number]} cur  current [x, z]
 * @param {[number, number]} next desired [x, z]
 * @returns {[number, number]} the position actually reached
 */
export function resolveMove(cur, next, blockers) {
  const [cx, cz] = cur;
  const [nx, nz] = next;
  const escaping = blocked(cx, cz, blockers);
  const x = escaping || !blocked(nx, cz, blockers) ? nx : cx;
  const z = escaping || !blocked(x, nz, blockers) ? nz : cz;
  return [x, z];
}
