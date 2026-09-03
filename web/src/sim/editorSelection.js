// ─────────────────────────────────────────────────────────────────────────────
// Multi-selection algebra and bulk operations for the room layout editor.
//
// The editor used to carry a single `sel = { kind, i } | null`, which made
// laying a floor a per-tile chore and made "shift the whole room 20cm" simply
// impossible. This module turns the selection into a SET and supplies the
// arithmetic every bulk action needs.
//
// Deliberately React-free and three.js-free, for the same reason taskScore.js
// and inspectionScore.js are: the editor is a 3D canvas that cannot be driven
// headlessly, so anything left inside the component is untestable by
// construction. Keeping the maths here means the untested surface of the
// feature is wiring only.
//
// A selection is an array of `{ kind: 'furniture'|'wall'|'station', i }`.
// `arrays` is `{ furniture, wall, station }` — the editor's three state arrays
// under their kind names.
//
// THE ONE TRAP: walls store their position under `p`, furniture and stations
// under `pos`. Every operation here routes through posKey() so a wall cannot
// silently stop moving while everything around it does.
// ─────────────────────────────────────────────────────────────────────────────

export const KINDS = ['furniture', 'wall', 'station'];

/** Match the editor's own 2-decimal quantisation (see commit() / duplicateSel). */
const r2 = (n) => Math.round(n * 100) / 100;

const posKey = (kind) => (kind === 'wall' ? 'p' : 'pos');

/** Fixture identity for "select all like this": .model, else .type. */
const likeKey = (it) => it?.model ?? it?.type ?? null;

// ── selection algebra ───────────────────────────────────────────────────────

export function has(sel, kind, i) {
  return (sel || []).some((r) => r.kind === kind && r.i === i);
}

/** Add the reference if absent, drop it if present. Never mutates `sel`. */
export function toggle(sel, ref) {
  const cur = sel || [];
  return has(cur, ref.kind, ref.i)
    ? cur.filter((r) => !(r.kind === ref.kind && r.i === ref.i))
    : [...cur, { kind: ref.kind, i: ref.i }];
}

/** Collapse to a single reference — a plain, unmodified click. */
export function replace(ref) {
  return [{ kind: ref.kind, i: ref.i }];
}

/**
 * Add the inclusive index run between `from` and `to` within one kind, in
 * ascending order. Direction-agnostic, so shift-clicking upward in a list
 * behaves the same as downward.
 */
export function rangeIn(sel, kind, from, to) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const out = [...(sel || [])];
  for (let i = lo; i <= hi; i += 1) if (!has(out, kind, i)) out.push({ kind, i });
  return out;
}

// ── bulk selection commands ─────────────────────────────────────────────────

/**
 * Every fixture sharing the reference's model/type key — the flooring case:
 * click one tile, get all of them. Non-furniture kinds have no meaningful
 * "like", so the reference is returned alone rather than selecting all walls
 * by surprise.
 */
export function selectAllLike(arrays, ref) {
  if (ref.kind !== 'furniture') return [{ kind: ref.kind, i: ref.i }];
  const list = arrays.furniture || [];
  const key = likeKey(list[ref.i]);
  if (key == null) return [{ kind: ref.kind, i: ref.i }];
  const out = [];
  list.forEach((it, i) => {
    if (likeKey(it) === key) out.push({ kind: 'furniture', i });
  });
  return out;
}

export function selectAllOfKind(arrays, kind) {
  return (arrays[kind] || []).map((_, i) => ({ kind, i }));
}

/** Everything, walls included — the move-the-whole-room case. */
export function selectAll(arrays) {
  return KINDS.flatMap((k) => selectAllOfKind(arrays, k));
}

export function countByKind(sel) {
  const out = { furniture: 0, wall: 0, station: 0 };
  for (const r of sel || []) if (r.kind in out) out[r.kind] += 1;
  return out;
}

// ── helpers shared by the mutating operations ───────────────────────────────

/** Selected indices per kind, ascending — the order copies are appended in. */
function indicesByKind(sel) {
  const out = { furniture: [], wall: [], station: [] };
  for (const r of sel || []) if (r.kind in out) out[r.kind].push(r.i);
  for (const k of KINDS) out[k].sort((a, b) => a - b);
  return out;
}

/** Copy an item so no array field is shared with the original. */
function cloneItem(it) {
  const out = { ...it };
  for (const k of Object.keys(out)) if (Array.isArray(out[k])) out[k] = [...out[k]];
  return out;
}

const readPos = (it, kind) => it[posKey(kind)] || [0, 0];

function writePos(it, kind, x, z) {
  const next = cloneItem(it);
  next[posKey(kind)] = [r2(x), r2(z)];
  return next;
}

// ── mutating operations ─────────────────────────────────────────────────────

/**
 * Append an offset copy of every selected item and return a selection pointing
 * at the copies. A single uniform offset is what preserves the arrangement —
 * duplicate a laid floor and you get the same floor beside it, not a pile.
 *
 * @returns {{ arrays: object, sel: Array }}
 */
export function duplicateAll(arrays, sel, offset = 0.4) {
  const idx = indicesByKind(sel);
  const next = { ...arrays };
  const nextSel = [];
  for (const kind of KINDS) {
    if (!idx[kind].length) continue;
    const list = [...(arrays[kind] || [])];
    for (const i of idx[kind]) {
      const src = list[i];
      if (!src) continue;
      const [x, z] = readPos(src, kind);
      nextSel.push({ kind, i: list.length });
      list.push(writePos(src, kind, x + offset, z + offset));
    }
    next[kind] = list;
  }
  return { arrays: next, sel: nextSel };
}

/**
 * Drop every selected item. Filtering against an index set rather than splicing
 * one at a time is what keeps this correct — sequential splices renumber the
 * array underneath the remaining indices and delete the wrong rows.
 */
export function deleteAll(arrays, sel) {
  const idx = indicesByKind(sel);
  const next = { ...arrays };
  for (const kind of KINDS) {
    if (!idx[kind].length) continue;
    const drop = new Set(idx[kind]);
    next[kind] = (arrays[kind] || []).filter((_, i) => !drop.has(i));
  }
  return next;
}

/** Shift every selected item by the same delta (arrow-key nudge). */
export function nudgeAll(arrays, sel, dx, dz) {
  const idx = indicesByKind(sel);
  const next = { ...arrays };
  for (const kind of KINDS) {
    if (!idx[kind].length) continue;
    const move = new Set(idx[kind]);
    next[kind] = (arrays[kind] || []).map((it, i) => {
      if (!move.has(i)) return it;
      const [x, z] = readPos(it, kind);
      return writePos(it, kind, x + dx, z + dz);
    });
  }
  return next;
}

// ── group transform ─────────────────────────────────────────────────────────

/**
 * Centroid of the selection, in [x, z]. This is where the gizmo's pivot sits,
 * so rotating a multi-selection turns it about its own middle rather than
 * about the world origin.
 */
export function groupPivot(arrays, sel) {
  const refs = (sel || []).filter((r) => KINDS.includes(r.kind));
  if (!refs.length) return [0, 0];
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (const r of refs) {
    const it = (arrays[r.kind] || [])[r.i];
    if (!it) continue;
    const [x, z] = readPos(it, r.kind);
    sx += x;
    sz += z;
    n += 1;
  }
  return n ? [sx / n, sz / n] : [0, 0];
}

/**
 * Apply one gizmo drag to every selected item: translate by (dx, dz), and
 * rotate about `pivot` by `dRy`.
 *
 * The rotation matches three.js' Y-rotation convention so the committed data
 * agrees with what was on screen during the drag:
 *   x' =  x·cos + z·sin
 *   z' = -x·sin + z·cos
 * `dRy` is also folded into each item's own `ry`, so a rotated group keeps each
 * piece facing the way it did relative to the group.
 */
export function applyPivotDelta(arrays, sel, pivot, { dx = 0, dz = 0, dRy = 0 } = {}) {
  const idx = indicesByKind(sel);
  const [px, pz] = pivot || [0, 0];
  const cos = Math.cos(dRy);
  const sin = Math.sin(dRy);
  const next = { ...arrays };
  for (const kind of KINDS) {
    if (!idx[kind].length) continue;
    const move = new Set(idx[kind]);
    next[kind] = (arrays[kind] || []).map((it, i) => {
      if (!move.has(i)) return it;
      const [x, z] = readPos(it, kind);
      const rx = x - px;
      const rz = z - pz;
      const out = writePos(it, kind, px + (rx * cos + rz * sin) + dx, pz + (-rx * sin + rz * cos) + dz);
      // Stations orbit the pivot but never gain an `ry`: they have no rotation in
      // the data model (stationLine does not serialise one), so writing it would
      // invent a field nothing reads.
      if (dRy && kind !== 'station') out.ry = (it.ry || 0) + dRy;
      return out;
    });
  }
  return next;
}
