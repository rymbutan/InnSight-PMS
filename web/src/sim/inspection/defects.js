// ─────────────────────────────────────────────────────────────────────────────
// The six things that can be wrong with a turned-over room, as data.
//
// Each defect owns four things:
//   • appliesTo(caseFile) — can this booking even support the fault? Two twin
//     beds are only a MISMATCH if the booking is a couple, so `room_mismatch`
//     refuses to be injected into a solo stay.
//   • apply(layout, caseFile) — how the room changes. Defects are expressed by
//     mutating the SAME `{model, pos, ry}` furniture data the room already
//     renders from, which is why the 3D room needed no rework ("retain layout").
//   • why — the reason a supervisor would give. Shown after grading.
//   • feedback — the correction when the student saw the fault but named it
//     wrongly. Distinguishing "left behind by the attendant" from "never
//     restocked" is the actual competency, so a miscategorisation is coached,
//     not just marked wrong.
//
// Props with no .glb in the library (vacuum, mop bucket, rags, chemicals, a
// rumpled duvet) are emitted as `{ prim: … }` entries and drawn with primitives
// by InspectionShift — the same approach the old Inspection3D used.
// ─────────────────────────────────────────────────────────────────────────────

import { LAYOUTS, canonicalTier } from '../roomLayouts.js';

// A fault can only be injected into a tier that owns the fixture it anchors to.
// Layouts are author-editable (Standard is authored in the Room Layout editor),
// so this is a runtime property of the layout, not a constant. Without this
// guard a student is graded on a fault that was never rendered.
function tierHas(roomTier, ...models) {
  const plan = LAYOUTS[canonicalTier(roomTier)];
  return !!plan?.furniture?.some((f) => models.includes(f.model));
}
const hasTowelAnchor = (roomTier = '') => tierHas(roomTier, 'towelrack', 'towel');
const hasBarAnchor = (roomTier = '') => tierHas(roomTier, 'minibar', 'wetbar');

// Deep-enough copy: furniture entries are flat records of primitives and short
// arrays, and `apply` must never mutate the caller's layout.
function cloneLayout(layout) {
  return {
    ...layout,
    furniture: (layout.furniture || []).map((f) => ({
      ...f,
      pos: Array.isArray(f.pos) ? [...f.pos] : f.pos,
      box: Array.isArray(f.box) ? [...f.box] : f.box,
      size: Array.isArray(f.size) ? [...f.size] : f.size,
    })),
  };
}

const findIdx = (furniture, model) => furniture.findIndex((f) => f.model === model);

export const DEFECTS = [
  {
    id: 'room_mismatch',
    category: 'room_mismatch',
    title: 'Room set-up does not match the booking',
    // Only a fault for a couple: two twins for two unrelated adults is correct,
    // and for a solo guest it is merely spare capacity.
    appliesTo: (c) => c.pax === 2 && c.children === 0,
    why: 'The booking is a couple, but the room is made up with two twin beds and single-occupancy toiletries. Bedding must match the party on the reservation — this is the fault a guest notices before they put their bags down.',
    feedback:
      'This was a booking mismatch, not general untidiness. The beds are made correctly; they are simply the wrong configuration for the guests arriving. Always read the party composition before judging the set-up.',
    anchorLabel: 'Beds',
    apply(layout) {
      const next = cloneLayout(layout);
      const i = findIdx(next.furniture, 'bed');
      if (i === -1) return next;
      const [x, z] = next.furniture[i].pos;
      const ry = next.furniture[i].ry;
      // `type`, not `model`: 'twin' has no registered .glb (see MODEL_FILES in
      // modelSizes.js) — FixtureBody only falls through to procedural geometry
      // for a `type`-tagged item, so `model: 'twin'` rendered NEITHER a real
      // asset NOR the procedural box bed already defined for it, just an empty
      // gap where the beds should be. The student had nothing to inspect, so
      // this defect could never be found — every pass on a two-adult booking
      // failed and sent the room back to Vacant Dirty regardless of how the
      // rest of the inspection went.
      next.furniture.splice(
        i,
        1,
        { type: 'twin', pos: [x - 0.95, z], ry },
        { type: 'twin', pos: [x + 0.95, z], ry }
      );
      return next;
    },
    anchorAt(layout) {
      const t = layout.furniture.filter((f) => f.type === 'twin');
      if (!t.length) return null;
      const x = t.reduce((s, f) => s + f.pos[0], 0) / t.length;
      const z = t.reduce((s, f) => s + f.pos[1], 0) / t.length;
      return { pos: [x, z], size: [2.8, 1.2, 2.2] };
    },
  },

  {
    id: 'amenity_math',
    category: 'amenity_math',
    title: 'Not enough amenities for the party size',
    // Needs a party large enough for a shortfall to exist at all.
    appliesTo: (c) => c.pax >= 3 && hasTowelAnchor(c.roomTier),
    why: 'The room is booked for more guests than there are bath towels and toiletries. Amenity counts are set from the party size on the reservation, not from a fixed pair per room.',
    feedback:
      'The towels here are clean and correctly placed — the fault is the COUNT against the booking, not their condition. Check the pax figure on the clipboard and compare it with what is actually laid out.',
    anchorLabel: 'Towels',
    apply(layout) {
      const next = cloneLayout(layout);
      // Strip the stacked towels and leave a single folded towel: visibly short
      // for a party of three or more.
      next.furniture = next.furniture.filter((f) => f.model !== 'towelstack');
      const rack = next.furniture.find((f) => f.model === 'towelrack');
      if (rack) {
        next.furniture.push({
          model: 'towel',
          pos: [...rack.pos],
          ry: rack.ry,
          y: (rack.y ?? 1.3) - 0.15,
        });
      }
      return next;
    },
    anchorAt(layout) {
      const rack = layout.furniture.find((f) => f.model === 'towelrack' || f.model === 'towel');
      return rack ? { pos: [...rack.pos], size: [1.0, 1.0, 1.0], y: rack.y ?? 1.2 } : null;
    },
  },

  {
    id: 'blocked_path',
    category: 'blocked_path',
    title: 'Walkway or exit is blocked',
    appliesTo: () => true,
    why: 'A large item has been left across the route to the bathroom and the door. Clear egress is a life-safety requirement, not a tidiness preference — it must be clear even when the room otherwise looks presentable.',
    feedback:
      'The issue here is obstruction, not the item itself being dirty or out of place decoratively. Anything that narrows the path to the bathroom or the exit is a safety fault and is escalated as one.',
    anchorLabel: 'Luggage rack',
    apply(layout) {
      const next = cloneLayout(layout);
      // This used to search for `model: 'sofa'` and drag it into the walkway. No
      // tier declares 'sofa' — they all use 'sofa3' — so the search never matched
      // and it silently fell through to this prop while the anchor still claimed
      // to be a "Sofa". Two separate faults, both now removed:
      //   1. A scenario must never RELOCATE a fixture. The room is the one the
      //      teacher laid out, and moving furniture into the through-route can
      //      wedge a student against real geometry.
      //   2. The obstruction is a `prim`, which carries no collision box, so it
      //      reads as blocking the walkway without ever being able to trap anyone.
      next.furniture.push({ prim: 'luggagerack', pos: [0, 0.6], size: [1.1, 0.6, 0.6] });
      return next;
    },
    anchorAt(layout) {
      const it = layout.furniture.find((f) => f.prim === 'luggagerack');
      return it ? { pos: [...it.pos], size: [1.8, 1.4, 1.4] } : null;
    },
  },

  {
    id: 'lingering_equipment',
    category: 'lingering_equipment',
    title: 'Cleaning equipment or chemicals left behind',
    appliesTo: () => true,
    why: 'The attendant left a vacuum and a mop bucket in the middle of the room and set cleaning chemicals down beside the guest toiletries. Chemicals next to items a guest puts on their skin is a contamination risk, and equipment left out means the room was never actually finished.',
    feedback:
      'This is equipment left behind by staff, not the room being under-stocked or used by a guest. The distinction matters: it is a service-recovery issue with the attendant, and the chemicals beside the toiletries make it a safety escalation.',
    anchorLabel: 'Cleaning equipment',
    apply(layout) {
      const next = cloneLayout(layout);
      next.furniture.push(
        { prim: 'vacuum', pos: [-0.9, -0.2], size: [0.35, 0.95, 0.45] },
        { prim: 'bucket', pos: [-0.3, 0.3], size: [0.42, 0.5, 0.42] }
      );
      // Presidential declares `type: 'twinvanity'`, so matching only on
      // `model: 'vanity'` silently skipped the chemicals-beside-the-toiletries
      // half of this fault in that tier.
      const vanity = next.furniture.find((f) => f.model === 'vanity' || f.type === 'twinvanity');
      if (vanity) {
        next.furniture.push({
          prim: 'chemicals',
          pos: [vanity.pos[0] - 0.35, vanity.pos[1]],
          size: [0.22, 0.34, 0.16],
          y: 0.95,
        });
      }
      return next;
    },
    anchorAt(layout) {
      const v = layout.furniture.find((f) => f.prim === 'vacuum');
      return v ? { pos: [...v.pos], size: [1.4, 1.4, 1.4] } : null;
    },
  },

  {
    id: 'lived_in',
    category: 'lived_in',
    title: 'Room still looks used — not reset to standard',
    appliesTo: () => true,
    why: 'At a glance the room reads as tidy, but the bed has not been stripped and remade and the curtains were left as the last guest pulled them. A room that looks broadly fine but is not reset to standard is the failure most likely to reach a guest, because it passes a quick look.',
    feedback:
      'Nothing here was left behind by staff and nothing is missing from stock — the room simply was not returned to standard. Judge the bed and window dressing against the brand set-up, not against whether the room looks superficially neat.',
    anchorLabel: 'Bed linen',
    apply(layout) {
      const next = cloneLayout(layout);
      const bed = next.furniture.find((f) => f.model === 'bed' || f.model === 'twin');
      if (bed) {
        next.furniture.push({
          prim: 'rumpled',
          pos: [bed.pos[0], bed.pos[1] + 0.25],
          size: [1.5, 0.22, 1.1],
          y: 0.62,
        });
      }
      // The curtain half of this cue is deliberately gone. It rotated the window
      // dressing by 0.5 rad, which read as broken geometry rather than as
      // "left as the last guest pulled them" — and it only ever fired in
      // Presidential, because Standard/Deluxe/Suite declare drapes under `type`,
      // not `model`, so the condition never matched there. It returns as an
      // authored `Curtain Haphazard` asset swapped in at the window slot, which
      // changes the ASSET without touching its placement.
      return next;
    },
    anchorAt(layout) {
      const r = layout.furniture.find((f) => f.prim === 'rumpled');
      if (r) return { pos: [...r.pos], size: [2.0, 1.2, 1.6], y: 0.8 };
      const bed = layout.furniture.find((f) => f.model === 'bed' || f.model === 'twin');
      return bed ? { pos: [...bed.pos], size: [2.0, 1.2, 1.6], y: 0.8 } : null;
    },
  },

  {
    id: 'incomplete_stock',
    category: 'incomplete_stock',
    title: 'Minibar or snack tray not properly stocked',
    appliesTo: (c) => hasBarAnchor(c.roomTier),
    why: 'The minibar is empty with no price list and no restocking indicator. An empty minibar is not merely a missing convenience — with no price list the guest cannot know what anything costs, and the hotel cannot bill for it.',
    feedback:
      'This is a stocking failure, not something left behind or a set-up mismatch. An empty unit with no price list is logged against the minibar run for the floor, and the missing price list is the part that has revenue consequences.',
    anchorLabel: 'Minibar',
    apply(layout) {
      const next = cloneLayout(layout);
      // Mark the unit as stripped so the renderer omits bottles and the card.
      const bar = next.furniture.find((f) => f.model === 'minibar' || f.model === 'wetbar');
      if (bar) bar.emptied = true;
      return next;
    },
    anchorAt(layout) {
      const bar = layout.furniture.find((f) => f.model === 'minibar' || f.model === 'wetbar');
      return bar ? { pos: [...bar.pos], size: [1.3, 1.4, 1.1], y: 0.7 } : null;
    },
  },
];

// Objects that are perfectly fine. Without decoys the only clickable things in
// the room would be the faults, and the exercise would collapse into "flag
// everything that highlights".
const DECOY_MODELS = [
  { model: 'wardrobe', label: 'Wardrobe' },
  { model: 'desk', label: 'Desk' },
  { model: 'tv', label: 'Television' },
  { model: 'art', label: 'Artwork' },
  { model: 'nightstand', label: 'Nightstand' },
  { model: 'toilet', label: 'Toilet' },
  { model: 'tub', label: 'Bathtub' },
  { model: 'plant', label: 'Plant' },
  { model: 'chair', label: 'Chair' },
];

/**
 * Apply every injected defect to the room and work out what is clickable.
 * Pure: the input layout is never mutated.
 *
 * @returns {{layout: object, anchors: Array}} anchors are
 *   `{ id, defectId|null, label, pos:[x,z], size:[w,h,d], y }`
 */
export function applyDefects(layout, caseFile) {
  let next = cloneLayout(layout);
  const injected = caseFile?.injected || [];

  for (const id of injected) {
    const def = DEFECTS.find((d) => d.id === id);
    if (def) next = def.apply(next, caseFile);
  }

  const anchors = [];
  for (const id of injected) {
    const def = DEFECTS.find((d) => d.id === id);
    if (!def) continue;
    const at = def.anchorAt(next);
    if (!at) continue;
    anchors.push({
      id: `d_${id}`,
      defectId: id,
      // Names the object, never its condition — the label must not give the
      // answer away before the student has judged it.
      label: def.anchorLabel,
      pos: at.pos,
      size: at.size,
      y: at.y,
    });
  }

  const taken = new Set(anchors.map((a) => `${a.pos[0]},${a.pos[1]}`));
  for (const d of DECOY_MODELS) {
    if (anchors.length >= injected.length + 5) break;
    const item = next.furniture.find((f) => f.model === d.model);
    if (!item) continue;
    const key = `${item.pos[0]},${item.pos[1]}`;
    if (taken.has(key)) continue;
    taken.add(key);
    anchors.push({
      id: `c_${d.model}`,
      defectId: null,
      label: d.label,
      pos: [...item.pos],
      size: [1.2, 1.4, 1.2],
      y: item.y,
    });
  }

  return { layout: next, anchors };
}
