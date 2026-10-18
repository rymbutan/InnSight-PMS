// ─────────────────────────────────────────────────────────────────────────────
// Twelve authored inspection scenarios: three per room tier, each with its own
// faults, decoys and placements.
//
// This is DATA in the same shape /api/training/scenarios stores — `swaps`,
// `added`, `tags` — so a scenario plays through fromScenario() like any the
// Scenario Maker saved, and nothing in grading needed to change. The room comes
// from the live tier layout; a scenario only says what is wrong with it.
//
// WHAT IT CAN USE is limited to what exists. Every prop is a registered .glb
// (MODEL_FILES); every fault is one of the six built-in categories or one of
// the three CATEGORIES below, which cover the stories the built-ins cannot tell
// (a pest, a guest's own item, an appliance that was not restocked).
//
// DESIGN RULES, enforced by tierScenarios.test.js:
//   • a scenario is wrong in 3+ ways and has 2+ decoys (things that LOOK
//     suspicious but are correct — signing them off clean is the right call)
//   • within a tier, no two scenarios share a fault model or a placement
//   • the booking is never assumed. `room_mismatch` and `amenity_math` depend
//     on the party and `amenity_math` also needs a towel rack no tier has, so
//     they are not used here; every fault below holds for any reservation
//   • labels name the object, never its condition ("Fridge", not "Empty fridge")
//   • props sit on free floor, off the entry lane, reachable from the door. The
//     one exception is the bench in a `blocked_path` fault, which is ON the
//     lane on purpose
//
// Fixtures are addressed as `<model>@<x>,<z>` (refOf in scenario.js). That ties a
// scenario to the layout as it stands: MOVE the fixture in the layout editor and
// its tag stops resolving. The test fails loudly when that happens.
// ─────────────────────────────────────────────────────────────────────────────

/** Custom fault categories these scenarios rely on. Seeded once, shared by all. */
export const CATEGORIES = [
  {
    key: 'pest',
    label: 'Pest or sanitation hazard',
    why: 'A pest, or a fixture left in an unsanitary state, is a health and reputation risk the moment a guest sees it. It is escalated to the supervisor and pest control straight away; the room is not released until it is cleared and sanitised.',
    feedback:
      'This was a sanitation hazard, not ordinary untidiness. Housekeeping can reset a messy bed, but a pest or a soiled fixture needs escalating before anyone touches it.',
  },
  {
    key: 'guest_item',
    label: 'Guest item left behind',
    why: 'This belongs to the previous guest. It is not rubbish and not hotel stock: it is bagged, tagged with the room and date, and logged to lost & found so it can be returned.',
    feedback:
      'This was not a cleanliness fault. A guest personal item is logged to lost & found, never thrown away or left where the next guest could find it.',
  },
  {
    key: 'restock',
    label: 'Appliance or amenity not restocked',
    why: 'Anything a guest is promised in the room, such as a stocked fridge, has to be reset to standard before the room is released. An empty appliance means the turnover was never finished.',
    feedback:
      'The fridge is clean and working. The fault is that it was never restocked to standard, which is a completeness issue rather than a cleanliness one.',
  },
];

const pest = 'category:pest';
const guestItem = 'category:guest_item';
const restock = 'category:restock';

// A decoy is a fixture that is correct as it stands.
const decoy = (ref, label, condition) => ({ ref, defectId: null, label, condition });

/**
 * Sets a tag on an added prop. `prop` ids are `<scenario>_<thing>`; the tag
 * refers to the prop through the same id.
 */
const onProp = (id, defectId, label, condition) => ({ ref: id, defectId, label, condition });

export const SCENARIOS = [
  // ═══ STANDARD ═══ compact, one bed, bathroom behind the divider ═══════════
  {
    key: 'STD-1',
    roomTier: 'Standard',
    name: 'STD-1 · Checkout in a Hurry',
    story: 'The guest left in a rush. The bed was abandoned and the attendant left their cart behind.',
    swaps: { 'bed@1.6,-1.3': 'messybed2' },
    added: [
      { id: 'std1_dishes', model: 'dishes', pos: [-1.7, 1.3], ry: 0.6 },
      { id: 'std1_cart', model: 'cleaningcart', pos: [-1.6, -1.9], ry: 0 },
    ],
    tags: [
      {
        ref: 'bed@1.6,-1.3',
        defectId: 'lived_in',
        label: 'Bed linen',
        condition: 'The duvet is dragged half off and a pillow is on the floor.',
      },
      onProp('std1_dishes', 'lived_in', 'Dishes', 'Plates and a cup from the guest, left on the floor.'),
      onProp(
        'std1_cart',
        'lingering_equipment',
        'Cleaning cart',
        'The attendant cart, parked in the room and not taken back.'
      ),
      decoy('wardrobe@-2.9,-2.1', 'Wardrobe', 'Doors closed, nothing inside out of place.'),
      decoy('vanity@0.6,1.1', 'Vanity', 'Wiped down and dry.'),
    ],
  },
  {
    key: 'STD-2',
    roomTier: 'Standard',
    name: 'STD-2 · Blocked Route',
    story:
      'The room looks tidy at a glance, but a bench has been left across the way in and the chemicals are out.',
    swaps: { 'vanity@0.6,1.1': 'dirtysink' },
    added: [
      { id: 'std2_bench', model: 'divider', pos: [-0.9, 2.2], ry: 1.5708 },
      { id: 'std2_supplies', model: 'cleaningsupply', pos: [-1.2, 0.9], ry: 0.8 },
    ],
    tags: [
      onProp(
        'std2_bench',
        'blocked_path',
        'Bench',
        'A long bench standing across the walkway from the door.'
      ),
      onProp(
        'std2_supplies',
        'lingering_equipment',
        'Cleaning supplies',
        'A caddy of spray bottles and cloths on the floor.'
      ),
      {
        ref: 'vanity@0.6,1.1',
        defectId: 'lived_in',
        label: 'Vanity',
        condition: 'Toothpaste marks and water spots around the basin.',
      },
      decoy('bed@1.6,-1.3', 'Bed', 'Made up to standard, corners tight.'),
      decoy('officechair@-2,-0.1', 'Desk chair', 'Pushed in square, nothing on it.'),
    ],
  },
  {
    key: 'STD-3',
    roomTier: 'Standard',
    name: 'STD-3 · Pest Report',
    story: 'A sanitation inspection: something is living in the room and the rubbish was never taken out.',
    swaps: { 'bed@1.6,-1.3': 'dirtymattress' },
    added: [
      { id: 'std3_rat', model: 'rat', pos: [-1.2, 0.5], ry: 2.2 },
      { id: 'std3_bin', model: 'trashcan', pos: [-2.0, 1.2], ry: 0 },
      { id: 'std3_pile', model: 'clutterpile', pos: [-1.4, 2.3], ry: 1.1 },
    ],
    tags: [
      onProp('std3_rat', pest, 'Rat', 'A rat near the wardrobe, not moving away when approached.'),
      onProp('std3_bin', 'lived_in', 'Trash can', 'Full, with the lid pushed up.'),
      onProp(
        'std3_pile',
        'lived_in',
        'Pile of clutter',
        'A heap of wrappers and packaging by the door side.'
      ),
      {
        ref: 'bed@1.6,-1.3',
        defectId: 'lived_in',
        label: 'Bed',
        condition: 'Bare mattress with no sheets and a stain on it.',
      },
      decoy('pottedplant@2.5,-2.6', 'Potted plant', 'Healthy and dust-free.'),
      decoy('divider@1.3,0.2', 'Room divider', 'Clean and secure.'),
    ],
  },

  // ═══ DELUXE ═══ twin beds, desk, lounge, kids' corner, bathroom ═══════════
  {
    key: 'DLX-1',
    roomTier: 'Deluxe',
    name: 'DLX-1 · Family Stay',
    story:
      "A family with a child. The fridge was emptied, a bed left unmade, and cleaning chemicals are within a child's reach.",
    swaps: {
      'fridgestocked@-3.6,2': 'fridgeempty',
      'bed@0.25,-3.3': 'messybed',
    },
    added: [
      { id: 'dlx1_pile', model: 'clutterpile', pos: [-2.4, 1.5], ry: 0.4 },
      { id: 'dlx1_supplies', model: 'cleaningsupply', pos: [-2.0, 3.0], ry: 1.4 },
    ],
    tags: [
      {
        ref: 'fridgestocked@-3.6,2',
        defectId: 'incomplete_stock',
        label: 'Fridge',
        condition: 'Shelves are bare apart from one bottle.',
      },
      {
        ref: 'bed@0.25,-3.3',
        defectId: 'lived_in',
        label: 'Bed linen',
        condition: 'Sheets twisted and the cover on the floor.',
      },
      onProp('dlx1_pile', 'lived_in', 'Pile of clutter', 'Toys and wrappers heaped beside the play area.'),
      onProp(
        'dlx1_supplies',
        'lingering_equipment',
        'Cleaning supplies',
        "Left on the floor next to the play kitchen, at a child's height."
      ),
      decoy('playkitchen@-3.5,3.6', 'Play kitchen', "A children's toy supplied with the room, clean."),
      decoy('coffee@0.4,0.9', 'Coffee table', 'Clear and wiped.'),
    ],
  },
  {
    key: 'DLX-2',
    roomTier: 'Deluxe',
    name: 'DLX-2 · Bathroom Turnover',
    story: 'The bedroom is fine; the bathroom was not finished, and something is living in it.',
    swaps: { 'vanity@3.57,3.2': 'dirtysink' },
    added: [
      { id: 'dlx2_towel', model: 'towelfloor', pos: [2.2, 3.3], ry: 0.3 },
      { id: 'dlx2_rat', model: 'rat', pos: [1.6, 3.9], ry: 4.0 },
    ],
    tags: [
      {
        ref: 'vanity@3.57,3.2',
        defectId: 'lived_in',
        label: 'Vanity',
        condition: 'Hair and toothpaste in the basin.',
      },
      onProp('dlx2_towel', 'lived_in', 'Towel', 'A used towel dropped on the bathroom floor.'),
      onProp('dlx2_rat', pest, 'Rat', 'A rat on the bathroom floor beside the bathtub.'),
      decoy('tub@2.6,4.3', 'Bathtub', 'Scrubbed and dry.'),
      decoy('minibar@3.4,-1.2', 'Minibar', 'Fully stocked, seals intact.'),
      decoy('wardrobe@3.5,2', 'Wardrobe', 'Closed, hangers in place.'),
    ],
  },
  {
    key: 'DLX-3',
    roomTier: 'Deluxe',
    name: 'DLX-3 · After the Party',
    story:
      'A group used the room as a social space: cans, plates and rubbish, and a bench shoved across the entrance.',
    swaps: { 'bed@0.95,-3.3': 'dirtymattress' },
    added: [
      { id: 'dlx3_dishes', model: 'dishes', pos: [0.4, 0.9], ry: 0.2, y: 0.55 },
      { id: 'dlx3_can', model: 'canA', pos: [2.3, 1.0], ry: 1.0, y: 0.75 },
      { id: 'dlx3_bin', model: 'trashcan', pos: [1.8, 2.6], ry: 0 },
      { id: 'dlx3_bench', model: 'divider', pos: [-0.5, 2.1], ry: 1.5708 },
    ],
    tags: [
      {
        ref: 'bed@0.95,-3.3',
        defectId: 'lived_in',
        label: 'Bed',
        condition: 'Bare mattress, sheets nowhere to be seen.',
      },
      onProp('dlx3_dishes', 'lived_in', 'Dishes', 'Used plates left on the coffee table.'),
      onProp('dlx3_can', 'lived_in', 'Drinks can', 'An empty can on the desk.'),
      onProp('dlx3_bin', 'lived_in', 'Trash can', 'Overflowing beside the desk.'),
      onProp('dlx3_bench', 'blocked_path', 'Bench', 'A bench across the route from the door to the room.'),
      decoy('armchair@-3.4,-0.6', 'Armchair', 'Clean, cushions in place.'),
      decoy('orchid@-0.8,4.5', 'Orchid', 'A living plant provided by the hotel.'),
      decoy('bookshelf@3.4,0.5', 'Bookshelf', 'Dusted, books straight.'),
    ],
  },

  // ═══ SUITE ═══ living area, two beds, kitchenette, wet bar, bath ══════════
  {
    key: 'STE-1',
    roomTier: 'Suite',
    name: 'STE-1 · Two-Zone Reset',
    story: 'Both the living room and the bedroom were left used, so the order of work matters.',
    swaps: { 'bed@1.95,-0.1': 'messybed' },
    added: [
      { id: 'ste1_dishes', model: 'dishes', pos: [2.2, 4.7], ry: 0.9 },
      { id: 'ste1_bin', model: 'trashcan', pos: [-1.9, 3.4], ry: 0 },
    ],
    tags: [
      {
        ref: 'bed@1.95,-0.1',
        defectId: 'lived_in',
        label: 'Bed linen',
        condition: 'Duvet stripped half off, pillows scattered.',
      },
      onProp('ste1_dishes', 'lived_in', 'Dishes', 'Dishes left on the floor by the kitchenette.'),
      onProp('ste1_bin', 'lived_in', 'Trash can', 'Full, in the living area.'),
      decoy('sofa3@-0.8,0.5', 'Sofa', 'Cushions plumped, nothing on it.'),
      decoy('armchair@-1.2,-1.8', 'Armchair', 'Clean and squared up.'),
      decoy('wardrobe@0.2,-2', 'Wardrobe', 'Closed, rail empty.'),
    ],
  },
  {
    key: 'STE-2',
    roomTier: 'Suite',
    name: 'STE-2 · VIP Arrival Prep',
    story:
      'A VIP arrives soon. The room looks good, but the minibar was not stocked and a few details were missed.',
    swaps: {
      'minibar@-0.4,3.2': 'fridgeempty',
      'bed@2.9,-0.1': 'messybed2',
      'vanity@-3.7,-3.4': 'dirtysink',
    },
    added: [{ id: 'ste2_supplies', model: 'cleaningsupply', pos: [1.3, 3.9], ry: 2.4 }],
    tags: [
      {
        ref: 'minibar@-0.4,3.2',
        defectId: 'incomplete_stock',
        label: 'Minibar',
        condition: 'Nothing in it; the welcome snacks are missing.',
      },
      {
        ref: 'bed@2.9,-0.1',
        defectId: 'lived_in',
        label: 'Bed linen',
        condition: 'Rumpled, one pillow off the bed.',
      },
      {
        ref: 'vanity@-3.7,-3.4',
        defectId: 'lived_in',
        label: 'Vanity',
        condition: 'Water marks and hair in the basin.',
      },
      onProp(
        'ste2_supplies',
        'lingering_equipment',
        'Cleaning supplies',
        'A caddy of chemicals left beside the kitchenette.'
      ),
      decoy('orchid@-4.2,-2.3', 'Orchid', 'The welcome plant, fresh.'),
      decoy('nightstand@0.5,0.7', 'Nightstand', 'Clear, lamp working.'),
      decoy('accentchair@3.4,3.6', 'Accent chair', 'Clean, nothing on it.'),
    ],
  },
  {
    key: 'STE-3',
    roomTier: 'Suite',
    name: 'STE-3 · Left Behind',
    story:
      'A guest checked out and left personal items. Some is rubbish, some is theirs, and the two must not be confused.',
    swaps: {},
    added: [
      { id: 'ste3_table', model: 'sidetable', pos: [-3.3, -0.6], ry: 0 },
      { id: 'ste3_toiletry', model: 'toiletry', pos: [-3.3, -0.6], ry: 0.5, y: 0.55 },
      { id: 'ste3_can', model: 'canB', pos: [-3.1, 1.4], ry: 0.7 },
      { id: 'ste3_pile', model: 'clutterpile', pos: [-3.9, 0.3], ry: 0.2 },
      { id: 'ste3_towel', model: 'towelfloor', pos: [2.4, -3.6], ry: 1.8 },
    ],
    tags: [
      onProp(
        'ste3_toiletry',
        guestItem,
        'Toiletry bottle',
        'A branded personal bottle, not hotel stock, on the side table.'
      ),
      onProp('ste3_can', 'lived_in', 'Drinks can', 'An empty can on the carpet.'),
      onProp(
        'ste3_pile',
        'lived_in',
        'Pile of clutter',
        'Wrappers and packaging heaped on the carpet by the lounge.'
      ),
      onProp('ste3_towel', 'lived_in', 'Towel', 'A used towel dropped on the floor of the sleeping area.'),
      decoy('ste3_table', 'Side table', 'Clean and steady.'),
      decoy('bookshelf@0.9,1.3', 'Bookshelf', 'Dusted, books straight.'),
      decoy('kitchenette@1.8,2.9', 'Kitchenette', 'Wiped, nothing out.'),
    ],
  },

  // ═══ PRESIDENTIAL ═══ multi-room: lounge, study, two beds, big bath ═══════
  {
    key: 'PRS-1',
    roomTier: 'Presidential',
    name: 'PRS-1 · Pre-Arrival Inspection',
    story:
      'A quality check before a high-profile arrival. The faults are in the details, not the big pieces.',
    swaps: {
      'vanity@-2.05,-3.1': 'dirtysink',
      'fridgestocked@-6,2.9': 'fridgeempty',
    },
    added: [
      { id: 'prs1_supplies', model: 'cleaningsupply', pos: [-1.0, -4.6], ry: 0.7 },
      { id: 'prs1_toiletry', model: 'toiletry', pos: [1.5, -0.9], ry: 2.0, y: 0.75 },
    ],
    tags: [
      {
        ref: 'vanity@-2.05,-3.1',
        defectId: 'lived_in',
        label: 'Vanity',
        condition: 'Fingerprints on the mirror, water spots at the basin.',
      },
      {
        ref: 'fridgestocked@-6,2.9',
        defectId: restock,
        label: 'Fridge',
        condition: 'Empty, with none of the requested items inside.',
      },
      onProp(
        'prs1_supplies',
        'lingering_equipment',
        'Cleaning supplies',
        'A caddy of polish and cloths left by the bathroom.'
      ),
      onProp(
        'prs1_toiletry',
        guestItem,
        'Toiletry bottle',
        'A personal bottle, not hotel stock, left on the desk.'
      ),
      decoy('tub@-4.4,-5.1', 'Bathtub', 'Polished, no marks.'),
      decoy('bookshelf@-4.8,-2.6', 'Bookshelf', 'Dusted, books straight.'),
      decoy('kitchenette@-3.8,5.4', 'Kitchenette', 'Spotless.'),
    ],
  },
  {
    key: 'PRS-2',
    roomTier: 'Presidential',
    name: 'PRS-2 · Executive Stay',
    story: 'A working stay. The study was used and a bench and a cart are in the way.',
    swaps: { 'bed@3.1,5.5': 'messybed' },
    added: [
      { id: 'prs2_dishes', model: 'dishes', pos: [1.5, -0.9], ry: 0.4, y: 0.75 },
      { id: 'prs2_can', model: 'canB', pos: [3.8, -0.3], ry: 1.3, y: 0.67 },
      { id: 'prs2_cart', model: 'cleaningcart', pos: [2.8, 2.4], ry: 0.3 },
      { id: 'prs2_bench', model: 'divider', pos: [0, 3.4], ry: 1.5708 },
    ],
    tags: [
      {
        ref: 'bed@3.1,5.5',
        defectId: 'lived_in',
        label: 'Bed linen',
        condition: 'Slept in and left, covers twisted.',
      },
      onProp('prs2_dishes', 'lived_in', 'Dishes', 'Plates and cutlery left on the desk.'),
      onProp('prs2_can', 'lived_in', 'Drinks can', 'An empty can on the coffee table.'),
      onProp(
        'prs2_cart',
        'lingering_equipment',
        'Cleaning cart',
        'The housekeeping cart, left inside the suite.'
      ),
      onProp('prs2_bench', 'blocked_path', 'Bench', 'A bench across the route from the entrance.'),
      decoy('officechair@2,-0.9', 'Desk chair', 'Pushed in, nothing on it.'),
      decoy('bookshelf@1.4,-2.5', 'Bookshelf', 'Dusted, books straight.'),
      decoy('sidetable@1.5,0.4', 'Side table', 'Clear apart from the hotel plant.'),
    ],
  },
  {
    key: 'PRS-3',
    roomTier: 'Presidential',
    name: 'PRS-3 · Event Aftermath',
    story:
      'The suite hosted a private dinner. The aftermath is spread across the lounge, borrowed furniture is still there, and someone slept over.',
    swaps: { 'bed@4.1,5.5': 'dirtymattress' },
    added: [
      { id: 'prs3_can', model: 'canA', pos: [-3.2, -0.7], ry: 0.5, y: 0.67 },
      { id: 'prs3_bin', model: 'trashcan', pos: [-4.6, 2.9], ry: 0 },
      { id: 'prs3_pile', model: 'clutterpile', pos: [-2.2, 3.9], ry: 0.9 },
      { id: 'prs3_towel', model: 'towelfloor', pos: [-3.0, -5.4], ry: 1.4 },
      { id: 'prs3_chair', model: 'accentchair', pos: [2.6, 1.9], ry: 3.6 },
      { id: 'prs3_ottoman', model: 'ottoman', pos: [-1.0, 4.4], ry: 0 },
    ],
    tags: [
      {
        ref: 'bed@4.1,5.5',
        defectId: 'lived_in',
        label: 'Bed',
        condition: 'Bare mattress, the sheets gone.',
      },
      onProp('prs3_can', 'lived_in', 'Drinks can', 'Empty cans left on the lounge coffee table.'),
      onProp('prs3_bin', 'lived_in', 'Trash can', 'Overflowing with food packaging.'),
      onProp('prs3_pile', 'lived_in', 'Pile of clutter', 'Napkins and wrappers in a heap.'),
      onProp('prs3_towel', 'lived_in', 'Towel', 'A used towel on the bathroom floor.'),
      decoy('prs3_chair', 'Accent chair', 'Extra seating that belongs in this suite.'),
      decoy('prs3_ottoman', 'Ottoman', 'Clean and in its usual spot.'),
      decoy('sofa3@-5.25,-0.7', 'Sofa', 'Plumped and clear.'),
    ],
  },
];

/**
 * Turn a definition into the body POST /api/training/scenarios accepts.
 *
 * Tag ids in this file are written `category:<key>` for the three custom
 * categories, because the real id (custom_<slug>) is minted by whichever
 * database the seed runs against and can differ between them.
 *
 * @param {object} def
 * @param {Record<string,string>} categoryIds  CATEGORIES key → custom_ id
 */
export function toPayload(def, categoryIds) {
  const resolve = (id) => {
    if (typeof id === 'string' && id.startsWith('category:')) {
      const real = categoryIds[id.slice('category:'.length)];
      if (!real) throw new Error(`${def.key}: no category id for "${id}"`);
      return real;
    }
    return id ?? null;
  };
  return {
    name: def.name,
    roomTier: def.roomTier,
    active: true,
    furniture: [],
    anchors: [],
    swaps: def.swaps || {},
    added: (def.added || []).map((a) => ({ ...a })),
    tags: (def.tags || []).map((t) => ({
      ref: t.ref,
      defectId: resolve(t.defectId),
      label: t.label ?? undefined,
      ...(t.condition ? { condition: t.condition } : {}),
    })),
  };
}
