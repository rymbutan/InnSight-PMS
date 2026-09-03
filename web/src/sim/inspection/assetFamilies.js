// ─────────────────────────────────────────────────────────────────────────────
// Swappable-asset families for the scenario builder.
//
// Authoring a fault used to take three steps: delete the clean fixture, find its
// faulted counterpart in a 71-entry alphabetical dropdown, then drag the new one
// back to where the original stood. The third step is how scenarios ended up
// moving furniture around — the exact thing that strands students and changes
// the room the teacher laid out.
//
// A family says "these assets are the same THING in different states", so the
// editor can offer a one-click swap that keeps position, rotation and size
// untouched. That makes the asset the only thing a scenario can vary, which is
// the rule the inspection is supposed to obey anyway.
//
// CONVENTIONS, enforced by assetFamilies.test.js:
//   • the CLEAN asset is listed first — it is the "reset to correct" affordance
//   • no model appears in two families, or familyOf() would be order-dependent
//   • every key must exist in MODEL_FILES
// ─────────────────────────────────────────────────────────────────────────────

/** family name → member model keys, clean state first. */
export const FAMILIES = {
  // The bed is the fixture most faults are told through: wrong configuration for
  // the booking, or simply never reset to standard.
  bed: ['bed', 'bedplain', 'messybed', 'messybed2', 'dirtymattress'],
  sofa: ['sofa3', 'unmadesofabed'],
  toilet: ['toilet', 'dirtytoilet'],
  vanity: ['vanity', 'dirtysink'],
  // A full stack, a single folded towel, and one dropped on the floor: the three
  // states that tell "enough / not enough / not reset".
  towels: ['towelstack', 'towel', 'towelfloor'],
  // A stocked unit, a stocked fridge, and an empty one — an empty minibar is only
  // legible next to a full one.
  minibar: ['minibar', 'fridgestocked', 'fridgeempty'],
  window: ['window', 'glasswindow'],
  divider: ['divider', 'divider2'],
  woodring: ['woodring', 'woodring2'],
  // Equipment a room attendant can leave behind. No "clean" member — the correct
  // state is the object not being in the room at all.
  cleaning: ['cleaningcart', 'cleaningsupply'],
  // Things a previous guest leaves. Same: correct state is absence.
  clutter: ['dishes', 'trashcan', 'clutterpile'],
};

/**
 * Human labels for the swap buttons. Without these a teacher is offered
 * "dirtymatress" — a raw filename, typo included — as the thing to click.
 */
export const LABELS = {
  bed: 'Made bed (king)',
  bedplain: 'Plain bed',
  messybed: 'Unmade bed',
  messybed2: 'Unmade bed (alt)',
  dirtymattress: 'Bare dirty mattress',
  sofa3: 'Sofa',
  unmadesofabed: 'Unmade sofa bed',
  toilet: 'Clean toilet',
  dirtytoilet: 'Dirty toilet',
  vanity: 'Clean vanity',
  dirtysink: 'Dirty sink',
  towelstack: 'Full towel stack',
  towel: 'Single folded towel',
  towelfloor: 'Towel on the floor',
  minibar: 'Minibar (stocked)',
  fridgestocked: 'Fridge (stocked)',
  fridgeempty: 'Fridge (empty)',
  window: 'Window',
  glasswindow: 'Glass window',
  divider: 'Room divider',
  divider2: 'Room divider (alt)',
  woodring: 'Wood ring',
  woodring2: 'Wood ring (alt)',
  cleaningcart: 'Cleaning cart',
  cleaningsupply: 'Cleaning supplies',
  dishes: 'Used dishes',
  trashcan: 'Trash can',
  clutterpile: 'Pile of clutter',
};

/** Label for a model key; falls back to the key so the UI never renders blank. */
export function labelFor(modelKey) {
  if (!modelKey) return '';
  return LABELS[modelKey] || modelKey;
}

// key → family name, built once. A Map keeps familyOf() O(1) and makes the
// "no model in two families" rule cheap to assert in the tests.
const INDEX = new Map();
for (const [name, keys] of Object.entries(FAMILIES)) {
  for (const k of keys) INDEX.set(k, name);
}

/** The family a model key belongs to, or null if it has no variants. */
export function familyOf(modelKey) {
  if (!modelKey) return null;
  return INDEX.get(modelKey) ?? null;
}

/**
 * The other assets this fixture can become — what the editor lists as swap
 * options. Empty for a fixture with no family, so the UI shows nothing rather
 * than falling back to the full model list.
 */
export function variantsFor(modelKey) {
  const fam = familyOf(modelKey);
  if (!fam) return [];
  return FAMILIES[fam].filter((k) => k !== modelKey);
}

/** True when two model keys are interchangeable states of the same fixture. */
export function isVariantOf(a, b) {
  const fa = familyOf(a);
  return !!fa && fa === familyOf(b);
}
