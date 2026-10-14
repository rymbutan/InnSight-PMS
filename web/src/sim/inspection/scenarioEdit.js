// Pure editing logic for the Scenario Editor, kept out of the React component so
// node --test can exercise it: the payload the editor saves, the objects it
// rebuilds when a scenario is opened, and the yaw read back from the gizmo.
//
// No React, no three.js and no network in here on purpose.

/**
 * Yaw (rotation about Y) from a quaternion, in radians, in (-PI, PI].
 *
 * Reading `object.rotation.y` after TransformControls is wrong beyond 90 degrees:
 * three re-derives Euler angles (order XYZ) from the quaternion, and for that
 * order the Y angle is confined to [-90, 90] — a facing of 135 degrees comes back
 * as 45 with X and Z flipped by 180. The yaw of the forward axis is unambiguous
 * though: it is atan2(m13, m33) of the rotation matrix, i.e. the YXZ Euler Y.
 */
export function yawFromQuaternion(q) {
  const { x, y, z, w } = q;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y));
}

/** Fixtures from the room's built-in layout are locked in position, delete and duplicate. */
export const isLockedBase = (o) => !!o && !o.added;

/** True for the primitive-box props that are no longer supported. */
export const isPrimObject = (o) => !!o && !!o.prim && !o.model;

/** Editor-only bookkeeping that must never ride along onto a copy. */
const stripPrivate = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));

/**
 * A duplicate of an ADDED object: a fresh id, still `added`, offset so it is
 * visible, and none of the `_ref` / `_base*` identity the original may carry —
 * a copied `_ref` would give two objects one tag ref.
 */
export function duplicateAdded(obj, id) {
  const copy = stripPrivate(obj);
  return { ...copy, id, added: true, pos: [obj.pos[0] + 0.5, obj.pos[1] + 0.5] };
}

const defaultLabelFor = (o) =>
  (o.model || 'Item').replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

/**
 * What a scenario stores about the live tier layout: the fixtures whose asset,
 * facing, size or height differ (swaps), the objects the author added, and the
 * tags. `furniture` and `anchors` go out empty — a non-empty furniture array is
 * how fromScenario() recognises a legacy snapshot.
 */
export function buildScenarioPayload({ objects, name, tier }) {
  const swaps = {};
  const added = [];
  const tags = [];
  for (const o of objects) {
    const ref = o.added ? o.id : o._ref;
    if (o.added) {
      added.push({
        id: o.id,
        model: o.model,
        pos: o.pos,
        ry: o.ry ?? 0,
        ...(o.y !== undefined ? { y: o.y } : {}),
        ...(o.scale ? { scale: o.scale } : {}),
      });
    } else {
      // Only record a difference. Swapping back to the shipped asset removes the
      // override rather than pinning the fixture.
      const modelChanged = o.model && o._baseModel && o.model !== o._baseModel;
      const ryChanged = Math.abs((o.ry ?? 0) - (o._baseRy ?? 0)) > 1e-6;
      const base = o._baseScale || [1, 1, 1];
      const cur = o.scale || [1, 1, 1];
      const scaleChanged = cur.some((n, i) => Math.abs(n - base[i]) > 1e-6);
      const yChanged = Math.abs((o.y ?? 0) - (o._baseY ?? 0)) > 1e-6;
      if (modelChanged || ryChanged || scaleChanged || yChanged) {
        swaps[ref] = {
          ...(modelChanged ? { model: o.model } : {}),
          ...(ryChanged ? { ry: o.ry ?? 0 } : {}),
          ...(scaleChanged ? { scale: cur } : {}),
          ...(yChanged ? { y: o.y ?? 0 } : {}),
        };
      }
    }
    if (o.defectId !== undefined) {
      tags.push({ ref, defectId: o.defectId || null, label: o.label || defaultLabelFor(o) });
    }
  }
  return {
    name: (name || '').trim(),
    roomTier: tier,
    // Explicitly null, not omitted: saving must clear a stale booking.
    booking: null,
    furniture: [],
    anchors: [],
    swaps,
    added,
    tags,
  };
}

/**
 * Why a payload cannot be saved yet, or '' when it can.
 */
export function savableProblem(payload, faults) {
  if (!payload.name) return 'Give the scenario a name first.';
  if (!faults) return 'Tag at least one object as a fault, or there is nothing to find.';
  return '';
}

/**
 * Rebuild the editor's objects from a stored scenario: the CURRENT tier layout
 * (`seed`, as produced by the editor's seedFromTier) with the saved overlay laid
 * on top. Primitive props are dropped, and so are tags that no longer resolve;
 * both are counted so the editor can say so instead of losing them silently.
 *
 * A legacy row (non-empty `furniture`) renders as authored and is flagged
 * `legacy` — it has no stable refs, so it cannot be saved back by this editor.
 *
 * @returns {{objects: Array, legacy: boolean, droppedTags: number, droppedPrims: number}}
 */
export function objectsFromScenario(s, seed, makeId) {
  if (Array.isArray(s.furniture) && s.furniture.length) {
    const tagged = new Map((s.anchors || []).map((a) => [a.id, a]));
    let droppedPrims = 0;
    const objects = [];
    for (const f of s.furniture) {
      if (isPrimObject(f)) {
        droppedPrims += 1;
        continue;
      }
      const a = tagged.get(f.id);
      objects.push({
        ...f,
        id: f.id || makeId(),
        defectId: a ? a.defectId || null : undefined,
        label: a?.label,
      });
    }
    return { objects, legacy: true, droppedTags: 0, droppedPrims };
  }

  const swaps = s.swaps || {};
  const tagByRef = new Map((s.tags || []).map((t) => [t.ref, t]));
  const used = new Set();
  const objects = seed.map((o) => {
    const sw = swaps[o._ref];
    const model = typeof sw === 'string' ? sw : sw?.model;
    const ry = sw && typeof sw === 'object' && sw.ry !== undefined ? sw.ry : o.ry;
    const scale = sw && typeof sw === 'object' && sw.scale ? sw.scale : o.scale;
    const y = sw && typeof sw === 'object' && sw.y !== undefined ? sw.y : o.y;
    const t = tagByRef.get(o._ref);
    if (t) used.add(o._ref);
    return {
      ...o,
      ...(model ? { model } : {}),
      ...(scale ? { scale } : {}),
      ...(y !== undefined ? { y } : {}),
      ry,
      defectId: t ? (t.defectId ?? null) : undefined,
      label: t?.label,
    };
  });
  let droppedPrims = 0;
  for (const a of s.added || []) {
    if (isPrimObject(a)) {
      droppedPrims += 1;
      used.add(a.id); // its tag goes with it and is not counted as a lost tag
      continue;
    }
    const t = tagByRef.get(a.id);
    if (t) used.add(a.id);
    objects.push({ ...a, added: true, defectId: t ? (t.defectId ?? null) : undefined, label: t?.label });
  }
  const droppedTags = [...tagByRef.keys()].filter((ref) => !used.has(ref)).length;
  return { objects, legacy: false, droppedTags, droppedPrims };
}
