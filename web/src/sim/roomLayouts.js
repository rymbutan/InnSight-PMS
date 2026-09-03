// ─────────────────────────────────────────────────────────────────────────────
// Per-room-type floor plans for the free-roam housekeeping shift.
//
// Each plan is pure data: room dimensions, a furniture list, a spawn point, and
// the station list (each station = a task to perform, with its world position).
// RoomFreeRoam renders geometry, derives collision, and places station markers
// entirely from this — so a Suite is a bigger, multi-zone space with more stations
// than a Standard, with no special-case code.
//
// Higher tiers ADD stations (more mini-games): living-area clean, welcome amenity
// set-up, turndown service, wet bar, a second bathroom, dining set-up, balcony
// tidy — grounded in the Fundamentals of Lodging Wk 14–15 outline and the
// Room-Amenities lab rubric.
//
// ── PLACEMENT IS COMPUTED, NOT GUESSED ───────────────────────────────────────
// Positions used to be hand-typed, and they were wrong in ways a 2D footprint
// check couldn't see: the Standard bed sat 29 cm off its headboard wall, the
// nightstands floated 45 cm out, the Presidential bathtub cut 14 cm into a wall
// and its toilet passed straight through one, the wardrobe was rotated 90° so it
// protruded 1.2 m into the room on a 0.6 m contact face, and the vanities faced
// the wall with their own mirror hanging in mid-air.
//
// Now every wall-hugging fixture is placed with `atBack/atFront/atLeft/atRight`,
// which take the fixture's RENDERED footprint and return the centre coordinate
// that puts its back face on the wall. `FP` holds those footprints; regenerate the
// table with `node scripts/check-room-layouts.mjs --sizes`, and note that the
// validator's BOX≠VISUAL check fails if `FP` drifts from what actually renders.
//
// Axes: x = left(−)…right(+), z = back/windows(−)…front/entrance(+).
// Verified by scripts/check-room-layouts.mjs (gameplay reachability AND 3D fit).
// ─────────────────────────────────────────────────────────────────────────────

// Collision footprint per PROCEDURAL furniture type: [width(x), depth(z), solid].
export const FOOTPRINTS = {
  bed: [1.95, 2.05, true],
  twin: [1.4, 2.0, true],
  nightstand: [0.6, 0.6, true],
  sofa: [2.26, 0.95, true],
  coffee: [1.1, 0.6, true],
  desk: [1.55, 0.58, true],
  chair: [0.5, 0.5, true],
  minibar: [1.13, 0.66, true],
  wetbar: [1.8, 0.7, true],
  wardrobe: [1.3, 0.62, true],
  vanity: [1.6, 0.56, true],
  tub: [1.75, 0.8, true],
  toilet: [0.4, 0.7, true],
  dining: [1.9, 1.1, true],
  counter: [2.0, 0.7, true],
  plant: [0.64, 0.64, true],
  tv: [1.6, 0.45, true],
  rug: [0, 0, false],
  balcony: [0, 0, false],
  lamp: [0, 0, false],
  // Presidential-suite fixtures
  officechair: [0.76, 0.75, true],
  armchair: [1.06, 0.84, true],
  walkin: [2.6, 0.65, true],
  deckTub: [2.5, 1.05, true],
  twinvanity: [2.2, 0.6, true],
  shower: [1.46, 0.76, true],
  console: [2.0, 0.45, true],
  tvwall: [0, 0, false],
  drape: [0, 0, false],
  mirror: [0, 0, false],
  pendant: [0, 0, false],
  wallart: [0, 0, false],
  panel: [0, 0, false],
};

// All four tiers are now authored in the Room Layout editor and stored as plain
// literals below, so the helpers that used to COMPUTE placements (FP, atBack /
// atFront / atLeft / atRight, outFrom / inFrom, RY, WALL_C) have no callers left
// and were removed. Collision footprints still live in FOOTPRINTS above, which
// the sim and the validator both read.
//
// Fixture sizes can still be printed with: node scripts/check-room-layouts.mjs --sizes

// ── The four tiers ───────────────────────────────────────────────────────────
// Std/Deluxe/Suite share one believable hotel arrangement:
//   • You ENTER at front-center (+z); the bathroom is walled into the front-right
//     corner by the door, with the entry lane kept clear.
//   • The BED is centered on the back (window) wall, headboard flush to the wall,
//     with symmetric nightstands — it anchors the room.
//   • A LOUNGE (sofa + coffee table on a rug) floats in the center facing the
//     media wall on the front wall.
//   • Deluxe/Suite add a work desk / reading nook and, for the Suite, a dining
//     set and wet bar down one side.
//
// All three now use real .glb models rather than procedural boxes — Standard,
// Deluxe and Suite previously contained ZERO models between them (78 fixtures,
// all `RoundedBox` with flat hex colours), while ~13 registered .glb assets went
// unused and every rug was a grey-blue plane.
const LAYOUTS = {
  // ── Standard ────────────────────────────────────────────────────────────────
  // Authored in the Room Layout editor by the user and baked in here on
  // 2026-09-01 so EVERY browser sees it, not just the one that authored it.
  // A verbatim copy lives in web/src/sim/layout-backups/.
  Standard: {
    tier: 'Standard',
    w: 6.4,
    l: 6,
    spawn: [0, 3.2],
    floor: '#5a3d28',
    walls: [],
    furniture: [
      { model: 'bed', pos: [1.6, -1.3], ry: -Math.PI / 2, scale: [1, 2, 1], y: 0.1, box: [1.95, 2.05] },
      { model: 'nightstand', pos: [2.5, -2.6], y: 0.1, box: [0.59, 0.59] },
      { type: 'lamp', pos: [2.5, -2.6], ry: -Math.PI / 2, y: 0.1 },
      { model: 'wardrobe', pos: [-2.9, -2.1], ry: Math.PI / 2, scale: [1.3, 1.1, 1], box: [1.3, 0.62] },
      { type: 'pendant', pos: [0.3, -1] },
      { model: 'rugLiving', pos: [1.1, -1.1], scale: [1.2, 1, 1.4] },
      { model: 'pottedplant', pos: [2.5, -2.6], scale: [0.5, 0.4, 0.3], y: 0.1, box: [0.64, 0.64] },
      { type: 'tvwall', pos: [1.3, 0.5], ry: Math.PI, scale: [1.4, 0.9, 1] },
      { model: 'slatwall', pos: [1.3, 0.6], ry: 0, scale: [1.8, 1.1, 1], box: [0.8, 0.8] },
      { model: 'foyer', pos: [-2.9, -2.1], ry: Math.PI / 2, scale: [0.8, 0.8, 1], y: 2.4, box: [2.2, 0.45] },
      { type: 'desk', pos: [-2.7, -0.2], ry: Math.PI / 2, scale: [1.2, 1.1, 1] },
      { model: 'officechair', pos: [-2, -0.1], ry: -Math.PI / 2, scale: [1.1, 1.4, 1] },
      { type: 'tv', pos: [-2.9, -0.2], ry: -Math.PI / 2, scale: [1, 1, 0.4], y: 0.3 },
      {
        model: 'city',
        pos: [-2.89, -0.2],
        ry: Math.PI / 2,
        scale: [0.17, 0.28, 0.18],
        y: 1.1,
        box: [7, 0.12],
      },
      { model: 'curtain', pos: [2.8, -2.4], ry: -Math.PI / 2, scale: [0.5, 1.1, 1], y: 0.2, box: [0.8, 0.8] },
      { model: 'window', pos: [3.2, -1.2], ry: Math.PI / 2, scale: [1, 0.7, 1], y: 1.2, box: [3, 0.15] },
      { model: 'wallpanel', pos: [-3.1, 1.4], ry: Math.PI / 2, scale: [1, 1.15, 1], box: [0.8, 0.8] },
      { model: 'wallpanel', pos: [-3.1, -1.2], ry: Math.PI / 2, scale: [-1.1, 1.15, 1], box: [0.8, 0.8] },
      { type: 'shower', pos: [2.5, 1.4], ry: Math.PI / 2, scale: [1, 1.3, 1], y: -0.2 },
      { type: 'shower', pos: [2.5, 2.49], ry: 0, scale: [1, 1.3, 0.7], y: -0.2 },
      { type: 'shower', pos: [0.2, 1.4], ry: Math.PI, scale: [1, 1.3, 1], y: -0.2 },
      { model: 'vanity', pos: [0.6, 1.1], scale: [1.1, 1.3, 1.2], box: [0.8, 0.8] },
      { model: 'shower', pos: [2.6, 1.8], ry: -Math.PI / 2, scale: [1.5, 1.2, 1.4] },
      { model: 'curtain', pos: [1.8, 2], ry: Math.PI / 2, y: 0.1 },
      { model: 'city', pos: [3.2, -1.2], ry: Math.PI / 2, scale: [0.4, 0.7, -0.7], y: 1.1, box: [7, 0.12] },
      { model: 'curtain', pos: [2.8, -0.1], ry: -Math.PI / 2, scale: [0.5, 1.1, 1], y: 0.2, box: [0.8, 0.8] },
      { model: 'divider', pos: [1.3, 0.2], ry: Math.PI, scale: [1.7, 2, 1.4], box: [0.8, 0.8] },
      { model: 'art', pos: [-3.07, 2.02], ry: Math.PI / 2, scale: [1.32, 1.3, 1], y: 1.97, box: [0.8, 0.8] },
      { model: 'art', pos: [-3.07, 2.02], ry: Math.PI / 2, scale: [1.32, 0.7, 1], y: 1.4, box: [0.8, 0.8] },
      { model: 'art', pos: [-3.07, 2.02], ry: Math.PI / 2, scale: [1.32, 0.6, 1], y: 0.9, box: [0.8, 0.8] },
    ],
    stations: [],
  },

  // ── Deluxe ──────────────────────────────────────────────────────────────────
  // Authored in the Room Layout editor by the user and baked in here on
  // 2026-09-01 (revision 2) so EVERY browser sees it, not just the one that
  // authored it. Versioned copies live in web/src/sim/layout-backups/.
  Deluxe: {
    tier: 'Deluxe',
    w: 7.6,
    l: 9.5,
    h: 2.6,
    spawn: [-1, 4.2],
    floor: '#5a3d28',
    walls: [
      { p: [-1.5, 4.75], w: 4.62, d: 0.1, c: '#d6d6d6' },
      { p: [0.8, 4.6], w: 2.74, d: 0.1, ry: Math.PI / 2, c: '#ebebeb' },
    ],
    furniture: [
      { model: 'desk', pos: [2.3, 1], ry: 0, box: [0.8, 0.8] },
      { model: 'officechair', pos: [2.2, 0.6], ry: 0.16, box: [0.8, 0.8] },
      { type: 'tv', pos: [2.3, 1.2], ry: 0, scale: [0.9, 0.7, 0.1], y: 0.4 },
      { model: 'wallpanel', pos: [3.7, 4.8], ry: -Math.PI / 2, scale: [1.3, 1, 1], box: [0.8, 0.8] },
      { model: 'wallpanel', pos: [3.7, 1.3], ry: -Math.PI / 2, scale: [-1, 1, 1], box: [0.8, 0.8] },
      { model: 'wallpanel', pos: [3.7, -3.3], ry: -Math.PI / 2, scale: [0.9, 1, 1], box: [0.8, 0.8] },
      { model: 'minibar', pos: [3.4, -1.2], ry: -Math.PI / 2, scale: [1.7, 1, 1.4], box: [0.8, 0.8] },
      { model: 'foyer', pos: [3.5, -1.2], ry: -Math.PI / 2, scale: [0.9, -0.8, 1], y: 2.7, box: [2.2, 0.45] },
      { model: 'bookshelf', pos: [3.4, 0.5], ry: -Math.PI / 2, scale: [0.6, 1, 1], box: [0.8, 0.8] },
      { type: 'panel', pos: [1.46, 1.3], scale: [2.3, 1.5, 0.1], s: [2, 1.94], c: '#b4916a' },
      { model: 'bed', pos: [0.25, -3.3], scale: [1, 1.6, 1], box: [1.95, 2.05] },
      { model: 'bed', pos: [0.95, -3.3], scale: [1, 1.6, 1], box: [1.95, 2.05] },
      { type: 'tvwall', pos: [0.3, 1.3], ry: Math.PI, scale: [0.9, 0.84, 0.9] },
      { model: 'coffee', pos: [0.4, 0.9], scale: [1.4, 1.3, 1], box: [1.1, 0.6] },
      { model: 'rugLiving', pos: [0.6, -1.5], scale: [1, 1, 0.9], y: 0.1 },
      { model: 'wardrobe', pos: [2.9, -4.3], scale: [1.1, 1, 1], box: [1.3, 0.62] },
      { model: 'curtain', pos: [-0.6, -4.6], scale: [0.9, 1, 1], box: [0.8, 0.8] },
      { model: 'curtain', pos: [1.3, -4.6], scale: [0.9, 1, 1], box: [0.8, 0.8] },
      { type: 'mirror', pos: [3.6, -3.2], ry: Math.PI / 2, scale: [1.2, 1.2, 1], y: -0.6 },
      { model: 'woodring', pos: [-1.1, -4.2], scale: [1.8, 1.7, 1.3], y: 0.1, box: [0.8, 0.8] },
      { model: 'desklamp', pos: [-1.1, -4.2], y: 0.7, c: '#ff40ff' },
      { model: 'shower', pos: [-2.8, -4.4], scale: [1.6, 1.3, 1.1] },
      { model: 'vanity', pos: [-1.9, -2.8], ry: -Math.PI / 2, scale: [0.8, 1, 1] },
      { model: 'wallpanel', pos: [-1.6, -3.5], ry: -Math.PI / 2, scale: [0.9, 1.1, -0.9], box: [0.8, 0.8] },
      { model: 'art', pos: [-1.56, -4], ry: Math.PI / 2, y: 1.8, box: [0.8, 0.8] },
      { model: 'toilet', pos: [-2, -3.7], ry: -Math.PI / 2, scale: [1.2, 1.2, 1], box: [0.8, 0.8] },
      { type: 'drape', pos: [-3.78, -4.1], ry: Math.PI / 2, scale: [0.6, 1.3, 0.1], s: [2, 2] },
      { type: 'drape', pos: [-3.78, -2.9], ry: Math.PI / 2, scale: [0.6, 1.3, 0.1], s: [2, 2] },
      { model: 'tv', pos: [-3.7, -3.2], ry: -Math.PI / 2, scale: [0.4, 1, 1], y: 1.2 },
      { type: 'shower', pos: [-2.27, -3.1], scale: [1, 1.4, 1.6], y: -0.1 },
      { model: 'slatwall', pos: [-3.8, -1.3], ry: -Math.PI / 2, scale: [1, 1.07, 0.2], box: [0.8, 0.8] },
      {
        type: 'panel',
        pos: [-3.8, -1.1],
        ry: -Math.PI / 2,
        scale: [2.8, 1.33, 0.1],
        s: [2, 1.94],
        c: '#b4916a',
      },
      { model: 'slatwall', pos: [-3.8, 0.7], ry: -Math.PI / 2, scale: [1, 1.07, 0.2], box: [0.8, 0.8] },
      { type: 'mirror', pos: [-3.8, -0.6], ry: Math.PI / 2, scale: [1.1, 1, 1], y: 0.1 },
      { model: 'window', pos: [-3.8, -0.5], ry: -Math.PI / 2, scale: [1, 0.7, 1], y: 0.8, box: [3, 0.15] },
      { model: 'divider', pos: [0.6, -2.1], scale: [1.4, 1.5, 2.1], box: [0.8, 0.8], c: '#831100' },
      { model: 'rugLiving', pos: [2.5, 3.1], ry: Math.PI, scale: [0.95, 1, 1.5] },
      { type: 'pendant', pos: [2.8, 2.1] },
      { model: 'wardrobe', pos: [3.5, 2], ry: -Math.PI / 2, scale: [0.9, 0.9, 1], y: 0.6, box: [1.3, 0.62] },
      { model: 'divider', pos: [3.5, 2], ry: -Math.PI / 2, scale: [1, 2.7, 1.5], box: [0.8, 0.8] },
      { type: 'pendant', pos: [2.7, 4.1] },
      { type: 'mirror', pos: [3.7, 3.2], ry: Math.PI / 2, scale: [1.1, 1, 1], y: 0.2 },
      { model: 'tub', pos: [2.6, 4.3], ry: 0, scale: [1.4, 1.5, 1.1] },
      { model: 'vanity', pos: [3.57, 3.2], ry: -Math.PI / 2, scale: [0.8, 1, 1] },
      { model: 'wallpanel', pos: [2.4, 1.4], scale: [-1, 1, 1], box: [0.8, 0.8] },
      { model: 'playkitchen', pos: [-3.5, 3.6], ry: Math.PI / 2, scale: [2.7, 2.2, 2.5], box: [0.8, 0.8] },
      { model: 'slidingdoor', pos: [0.8, 2.3], ry: Math.PI / 2, scale: [1, 1.4, 1.1] },
      { model: 'slatwall', pos: [-2.7, -4.7], ry: 0, scale: [-1.1, 1.07, -0.4], box: [0.8, 0.8] },
      { model: 'plant', pos: [-1.9, -2.8], y: 0.7, box: [0.8, 0.8] },
      { type: 'mirror', pos: [-1.71, -2.8], ry: Math.PI / 2, scale: [1.05, 0.8, 1], y: 0.1 },
      { model: 'bookshelf', pos: [3.8, 0.9], ry: -Math.PI / 2, scale: [0.6, 1, 1], box: [0.8, 0.8] },
      {
        model: 'bookshelf',
        pos: [-3.7, 3.2],
        ry: Math.PI / 2,
        scale: [0.8, 0.4, 1.2],
        y: 1.6,
        box: [0.8, 0.8],
      },
      { type: 'shower', pos: [2.3, 4.5], ry: 0, scale: [2.3, 1.3, 0.4], y: -0.1 },
      { model: 'plant', pos: [3.5, 3.2], y: 0.7, box: [0.8, 0.8] },
      { model: 'city', pos: [-3.8, -0.5], ry: -Math.PI / 2, scale: [0.4, 0.7, 1.1], y: 0.8, box: [7, 0.12] },
      { model: 'curtain', pos: [-3.65, 0.6], ry: -Math.PI / 2, scale: [0.6, 1, 1], box: [0.8, 0.8] },
      { model: 'curtain', pos: [-3.65, -1.7], ry: -Math.PI / 2, scale: [0.6, 1, 1] },
      { model: 'art', pos: [-0.4, 1.35], y: 1.2, box: [0.8, 0.8] },
      { model: 'art', pos: [0.3, 1.35], y: 1, box: [0.8, 0.8] },
      { model: 'orchid', pos: [-0.8, 4.5], scale: [1, 2.9, 2], box: [0.8, 0.8] },
      { model: 'armchair', pos: [-3.4, -0.6], ry: Math.PI / 2, scale: [0.9, 0.9, 0.9], box: [0.8, 0.8] },
      { model: 'ottoman', pos: [-3.4, 0.1], box: [0.8, 0.8] },
      { model: 'lamp', pos: [-3.4, 0.1], ry: 2.36, y: 0.4, box: [0.8, 0.8] },
      { model: 'fridgestocked', pos: [-3.6, 2], ry: Math.PI / 2, scale: [0.5, 0.4, 0.5], box: [0.8, 0.8] },
      { type: 'pendant', pos: [1.8, -2.6] },
      { type: 'pendant', pos: [0.1, -1] },
    ],
    stations: [],
  },
  // ── Suite ───────────────────────────────────────────────────────────────────
  // Authored in the Room Layout editor by the user and baked in here on
  // 2026-09-02. Versioned copies live in web/src/sim/layout-backups/.
  Suite: {
    tier: 'Suite',
    w: 9,
    l: 12,
    spawn: [0, 5.4],
    floor: '#5a3d28',
    walls: [
      { p: [2.3, 1.5], w: 4.5, d: 0.1, c: '#ffffff' },
      { p: [0, 0.7], w: 7.09, d: 0.1, ry: -Math.PI / 2, c: '#ffffff' },
      { p: [0, -0.6], w: 0.1, d: 0.1, ry: Math.PI / 2, c: '#ffffff' },
      { p: [-1, 4.2], w: 2.07, d: 0.1, c: '#ffffff' },
      { p: [-3.5, -3], w: 2.07, d: 0.1, c: '#ffffff' },
    ],
    furniture: [
      { type: 'tvwall', pos: [-4.5, 0.6], ry: Math.PI / 2 },
      { model: 'sofa3', pos: [-0.8, 0.5], ry: -Math.PI / 2, box: [0.8, 0.8] },
      { model: 'armchair', pos: [-1.2, -1.8], ry: -1.05, box: [0.8, 0.8] },
      { model: 'rugStudy', pos: [-1.1, 0.6], ry: Math.PI / 2, y: 0.01, w: 0, box: [3.2, 2.2] },
      { model: 'minibar', pos: [-0.4, 3.2], ry: -Math.PI / 2, scale: [1.6, 1, 1], box: [0.8, 0.8] },
      { model: 'divider', pos: [-1, 4.5], ry: 0, scale: [1.2, 1.9, 1.6], y: 0.1, box: [0.8, 0.8] },
      { model: 'art', pos: [-1.25, 4.3], y: 1.5, box: [0.8, 0.8] },
      { model: 'art', pos: [-0.75, 4.3], scale: [0.8, 0.5, 1], y: 1.5, box: [0.8, 0.8] },
      { model: 'wallpanel', pos: [-0.1, 2.3], ry: -Math.PI / 2, scale: [1.2, 1.15, 0.1], box: [0.8, 0.8] },
      { model: 'wallpanel', pos: [-0.1, -1.1], ry: -Math.PI / 2, scale: [-1.1, 1.15, 0.1], box: [0.8, 0.8] },
      { model: 'window', pos: [-4.3, 3.6], ry: -Math.PI / 2, scale: [0.7, 0.8, -0.2], y: 1, box: [3, 0.15] },
      { type: 'desk', pos: [-4.1, -1.7], ry: Math.PI / 2, scale: [1.2, 1.1, 1] },
      { model: 'curtain', pos: [-4.3, 5], ry: Math.PI / 2, scale: [0.8, 1.16, 1], box: [0.8, 0.8] },
      { model: 'curtain', pos: [-4.3, 2.4], ry: Math.PI / 2, scale: [0.5, 1.16, 1], box: [0.8, 0.8] },
      { model: 'city', pos: [-4.4, 3.3], ry: -Math.PI / 2, scale: [0.4, 0.8, -0.1], y: 1, box: [7, 0.12] },
      { model: 'coffee', pos: [-4.1, 3.6], ry: Math.PI / 2, scale: [1.2, 2.8, 1], box: [1.1, 0.6] },
      { model: 'officechair', pos: [-3.8, -1.7], ry: -Math.PI / 2, box: [0.8, 0.8] },
      { model: 'orchid', pos: [-4.2, -2.3], ry: Math.PI / 2, scale: [1.4, 1.3, 1], y: 0.9, box: [0.8, 0.8] },
      { model: 'lamp', pos: [-4.2, -1], ry: Math.PI / 2, scale: [0.8, 0.8, 1], y: 0.9, box: [0.8, 0.8] },
      { type: 'pendant', pos: [-3.5, -1.8], y: 0.5 },
      { model: 'art', pos: [-0.1, -0.4], ry: Math.PI / 2, scale: [1.1, 1, 1], y: 1.9, box: [0.8, 0.8] },
      { model: 'art', pos: [-0.1, 0.24], ry: Math.PI / 2, scale: [1.1, 1, 1], y: 1.9, box: [0.8, 0.8] },
      { model: 'art', pos: [-0.1, 0.87], ry: Math.PI / 2, scale: [1.1, 1, 1], y: 1.9, box: [0.8, 0.8] },
      { model: 'art', pos: [-0.1, 1.54], ry: Math.PI / 2, scale: [1.1, 1, 1], y: 1.9, box: [0.8, 0.8] },
      { model: 'slatwall', pos: [-3.5, -3], scale: [1, 1.24, 1], box: [0.8, 0.8] },
      { model: 'wallpanel', pos: [-4.4, -1.2], ry: Math.PI / 2, scale: [-1.1, 1.15, 0.1], box: [0.8, 0.8] },
      { model: 'wallpanel', pos: [-4.4, 2.3], ry: Math.PI / 2, scale: [1.2, 1.15, 0.1], box: [0.8, 0.8] },
      { type: 'shower', pos: [-3.2, -5.2], ry: Math.PI / 2, scale: [1.8, 1.4, 1], y: -0.2 },
      { model: 'rugLiving', pos: [-4.3, -4.7], scale: [1, 1, 1.4], box: [3.6, 2.6] },
      { model: 'shower', pos: [-3.6, -5.7], scale: [1.2, 1.1, 1] },
      { model: 'vanity', pos: [-3.7, -3.4], ry: Math.PI, scale: [1, 1.1, 1] },
      { type: 'pendant', pos: [-3.8, -4.3] },
      { model: 'rugLiving', pos: [2.3, -0.2], ry: Math.PI, scale: [1.1, 1, 1.3], box: [3.6, 2.6] },
      { model: 'bookshelf', pos: [0.9, 1.3], ry: Math.PI, scale: [0.9, 1.1, 1], box: [0.8, 0.8] },
      { model: 'bookshelf', pos: [3.7, 1.3], ry: Math.PI, scale: [0.8, 1.1, 1], box: [0.8, 0.8] },
      { model: 'foyer', pos: [2.34, 1.3], scale: [0.57, 1, 0.6], y: -0.1, box: [2.2, 0.45] },
      { model: 'foyer', pos: [2.3, 1.2], scale: [1.9, -0.8, 0.6], y: 3, box: [2.2, 0.45] },
      { type: 'mirror', pos: [2.35, 1.4] },
      { model: 'bed', pos: [1.95, -0.1], ry: Math.PI, scale: [1.2, 1.8, 1], box: [1.95, 2.05] },
      { model: 'nightstand', pos: [0.5, 0.7], y: 0.1, box: [0.8, 0.8] },
      { model: 'lamp', pos: [0.5, 0.6], ry: Math.PI, y: 0.7, box: [0.8, 0.8] },
      { model: 'window', pos: [4.5, 4.6], ry: -Math.PI / 2, scale: [0.7, 0.8, -0.2], y: 0.8, box: [3, 0.15] },
      {
        model: 'window',
        pos: [4.5, -0.7],
        ry: -Math.PI / 2,
        scale: [0.7, 0.8, -0.2],
        y: 0.9,
        box: [3, 0.15],
      },
      { type: 'mirror', pos: [4.51, 4.6], ry: Math.PI / 2, scale: [1.6, 1.05, 1], y: 0.2 },
      { model: 'curtain', pos: [4.4, 3.7], ry: -Math.PI / 2, scale: [0.5, 1, 1], y: 0.3, box: [0.8, 0.8] },
      { model: 'curtain', pos: [4.4, 5.3], ry: -Math.PI / 2, scale: [0.6, 1, 1], y: 0.3, box: [0.8, 0.8] },
      { type: 'mirror', pos: [4.51, -1.03], ry: Math.PI / 2, scale: [1.6, 1.05, 1], y: 0.3 },
      { model: 'curtain', pos: [4.4, -1.63], ry: -Math.PI / 2, scale: [0.6, 1, 1], y: 0.3, box: [0.8, 0.8] },
      { model: 'curtain', pos: [4.4, -0.03], ry: -Math.PI / 2, scale: [0.6, 1, 1], y: 0.3, box: [0.8, 0.8] },
      { model: 'wardrobe', pos: [0.2, -2], ry: Math.PI / 2, scale: [1.1, 1, 0.6], y: 0.1, box: [1.3, 0.62] },
      { type: 'mirror', pos: [0.1, -0.1], ry: Math.PI / 2, scale: [1.6, 1.05, 1], y: 0.2 },
      { model: 'foyer', pos: [0.2, -2], ry: -Math.PI / 2, scale: [0.6, -0.8, 0.6], y: 3, box: [2.2, 0.45] },
      { model: 'bed', pos: [2.9, -0.1], ry: Math.PI, scale: [1.2, 1.8, 1], box: [1.95, 2.05] },
      { model: 'kitchenette', pos: [1.8, 2.9], scale: [1, 1.1, 0.7], box: [0.8, 0.8] },
      {
        model: 'bookshelf',
        pos: [4.3, 2.4],
        ry: -Math.PI / 2,
        scale: [0.8, 1.1, 1],
        y: 0.5,
        box: [0.8, 0.8],
      },
      { model: 'divider', pos: [4.3, 2.4], ry: -Math.PI / 2, scale: [1.2, 1.9, 1.6], box: [0.8, 0.8] },
      { model: 'tv', pos: [2.6, 1.6], scale: [1.6, 1.6, 1], y: 1.3, box: [0.8, 0.8] },
      { model: 'accentchair', pos: [3.4, 3.6], ry: 3.58 },
      { model: 'toilet', pos: [-4.2, -4.5], ry: Math.PI / 2, box: [0.8, 0.8] },
    ],
    stations: [],
  },

  // ── Presidential ────────────────────────────────────────────────────────────
  // Authored in the Room Layout editor by the user and baked in here on
  // 2026-09-02. Versioned copies live in web/src/sim/layout-backups/.
  Presidential: {
    tier: 'Presidential',
    w: 12,
    l: 15,
    spawn: [0, 6.6],
    floor: '#5a3d28',
    walls: [
      { p: [0, 7.5], w: 11.98, d: 0.1, ry: 0, c: '#9a9ba2' },
      { p: [1.1, -1.23], w: 4.61, d: 0.1, ry: -Math.PI / 2, c: '#9a9ba2' },
      { p: [1.1, 5.67], w: 3.69, d: 0.1, ry: -Math.PI / 2, c: '#9a9ba2' },
      { p: [-4.1, -2.8], w: 6.01, d: 0.1, c: '#ffffff' },
    ],
    furniture: [
      { model: 'city', pos: [4.6, -7.5], scale: [1, 1.25, 0.4], box: [7, 0.12] },
      { model: 'city', pos: [6, -5.6], ry: -Math.PI / 2, scale: [0.6, 1.25, 1], box: [7, 0.12] },
      { type: 'balcony', pos: [3.2, -7.4] },
      { type: 'balcony', pos: [7.2, -7.4] },
      { type: 'balcony', pos: [5.9, -5.6], ry: Math.PI / 2 },
      { model: 'curtain', pos: [1, -6.8], ry: -Math.PI / 2, scale: [0.7, 1.18, -0.3], box: [0.8, 0.8] },
      { model: 'curtain', pos: [1.05, -4.2], ry: -Math.PI / 2, scale: [0.74, 1.18, -0.9], box: [0.6, 0.8] },
      { model: 'city', pos: [1.2, -5.5], ry: -Math.PI / 2, scale: [0.6, 1.25, -1.1], box: [7, 0.12] },
      { model: 'slidingdoor', pos: [3.56, -3.4], scale: [1.2, 1.45, -0.1], c: '#ffffff' },
      {
        model: 'glasswindow',
        pos: [1.76, -3.4],
        ry: Math.PI / 2,
        scale: [0.9, 1.27, 0.8],
        box: [0.8, 0.8],
        c: '#ffffff',
      },
      {
        model: 'glasswindow',
        pos: [5.32, -3.4],
        ry: Math.PI / 2,
        scale: [0.9, 1.27, 0.8],
        box: [0.8, 0.8],
        c: '#ffffff',
      },
      { model: 'glasswindow', pos: [1, -5.5], ry: 0, scale: [0.9, 1.27, 0.7], box: [0.8, 0.8], c: '#ffffff' },
      { type: 'balcony', pos: [1.1, -5.5], ry: Math.PI / 2, scale: [0.3, 1, 1], y: -0.1 },
      { model: 'rugBedroom', pos: [3.5, -2.8], scale: [0.4, 1, 0.4], y: 0.1, c: '#5a1c00' },
      { model: 'curtain', pos: [1, -4.2], ry: -Math.PI / 2, scale: [0.74, 1.18, -0.3], box: [0.8, 0.8] },
      { model: 'rugLiving', pos: [-3.7, -0.1], ry: Math.PI / 2, scale: [-1.4, 0.1, 1.9], y: 0.01 },
      { model: 'sofa3', pos: [-5.25, -0.7], ry: Math.PI / 2, box: [0.8, 0.8] },
      { model: 'walldeco', pos: [-5.95, -0.7], ry: Math.PI / 2, y: 1.5, box: [0.8, 0.8] },
      { model: 'chair', pos: [-4, 1.5], ry: 2.62, box: [0.8, 0.8] },
      { model: 'lamp', pos: [-5.4, 1], ry: 2.09, scale: [1.1, 2.9, 0.9], box: [0.8, 0.8] },
      { model: 'pottedplant', pos: [-5.3, 1.8], ry: Math.PI / 2, box: [0.8, 0.8] },
      { model: 'bookshelf', pos: [-4.8, -2.6], scale: [1.3, 1.4, 1], box: [0.8, 0.8] },
      { model: 'coffee', pos: [-3.2, -0.7], ry: Math.PI / 2, scale: [1.4, 1.6, 1.5], box: [1.1, 0.6] },
      { type: 'pendant', pos: [-3.73, 1.3], ry: Math.PI / 2, y: 0.3 },
      { type: 'pendant', pos: [-2.33, -0.1], ry: Math.PI / 2, y: 0.8 },
      { type: 'pendant', pos: [-3.93, -1.7], ry: Math.PI / 2, y: 0.8 },
      { type: 'console', pos: [-1.43, -0.1], ry: Math.PI / 2, scale: [2.4, 0.8, 1], y: -0.4, c: '#ff6a00' },
      { model: 'kitchenette', pos: [-3.8, 5.4], ry: 0, scale: [1.2, 1.2, 1.1], box: [0.8, 0.8] },
      { model: 'bed', pos: [4.1, 5.5], ry: Math.PI, scale: [1.2, 1.9, 1.1], box: [1.95, 2.05] },
      { model: 'bed', pos: [3.1, 5.5], ry: Math.PI, scale: [1.2, 1.9, 1.1], box: [1.95, 2.05] },
      { model: 'slidingdoor', pos: [1.1, 2.47], ry: Math.PI / 2, scale: [1.5, 1.45, -0.1], c: '#ffffff' },
      {
        model: 'rugLiving',
        pos: [3.6, 4.6],
        ry: Math.PI / 2,
        scale: [-1.3, 0.1, 1.9],
        y: 0.1,
        box: [3.6, 2.6],
      },
      { model: 'bookshelf', pos: [1.9, 6.9], ry: Math.PI, scale: [0.7, 1.1, 1], y: 0.6, box: [0.8, 0.8] },
      { model: 'lamp', pos: [1.6, 6.3], ry: 2.44, scale: [1.1, 2.9, 0.9], y: 0.1, box: [0.8, 0.8] },
      { model: 'foyer', pos: [2, 7], scale: [0.7, 0.8, 1], box: [2.2, 0.45] },
      { model: 'window', pos: [3.6, 7.35], scale: [0.6, 0.7, -0.2], y: 1.1, box: [3, 0.15] },
      { type: 'mirror', pos: [3.6, 7.4], scale: [1.4, 0.9, -0.5], y: 0.6 },
      { model: 'curtain', pos: [2.5, 7.2], scale: [0.5, 1, 1.2], y: 0.3, box: [0.8, 0.8] },
      { model: 'divider2', pos: [3.5, 7.4], scale: [1.8, 1.3, 1], y: -0.8, box: [0.8, 0.8] },
      { model: 'divider2', pos: [4.7, 7.4], scale: [1.7, -0.5, 1], y: 3.5, box: [0.8, 0.8] },
      { model: 'divider2', pos: [3.3, 7.4], scale: [1.7, -0.5, 1], y: 3.5, box: [0.8, 0.8] },
      { model: 'divider2', pos: [1.9, 7.4], scale: [1.7, -0.5, 1], y: 3.5, box: [0.8, 0.8] },
      { model: 'divider2', pos: [6.1, 7.4], scale: [1.7, -0.5, 1], y: 3.5, box: [0.8, 0.8] },
      { model: 'curtain', pos: [4.7, 7.2], scale: [0.5, 1, 1.2], y: 0.3, box: [0.8, 0.8] },
      { model: 'bookshelf', pos: [5.3, 6.9], ry: Math.PI, scale: [0.7, 1.1, 1], y: 0.6, box: [0.8, 0.8] },
      { model: 'foyer', pos: [5.2, 7], scale: [0.7, 0.8, 1], box: [2.2, 0.45] },
      { model: 'coffee', pos: [5.6, 6.1], ry: -Math.PI / 2, scale: [0.5, 2.1, 0.8], y: 0.1, box: [1.1, 0.6] },
      { model: 'hardwoodfloor', pos: [1.5, -3], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [2.3, -2.2], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.1, -3], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.9, -2.2], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [4.7, -3], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [5.5, -2.2], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [2.3, -3], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.9, -3], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [5.5, -3], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.1, -2.2], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [4.7, -2.2], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [6.3, -2.2], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [1.5, -2.2], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [6.3, -3], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [1.5, -1.4], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [2.3, -0.6], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.1, -1.4], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.9, -0.6], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [4.7, -1.4], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [5.5, -0.6], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [2.3, -1.4], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.9, -1.4], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [5.5, -1.4], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.1, -0.6], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [4.7, -0.6], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [6.3, -0.6], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [1.5, -0.6], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [6.3, -1.4], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [1.5, 0.2], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [2.3, 1], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.1, 0.2], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.9, 1], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [4.7, 0.2], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [5.5, 1], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [2.3, 0.2], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.9, 0.2], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [5.5, 0.2], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.1, 1], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [4.7, 1], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [6.3, 1], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [1.5, 1], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [6.3, 0.2], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [1.5, 1.8], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [2.3, 2.6], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.1, 1.8], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.9, 2.6], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [4.7, 1.8], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [5.5, 2.6], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [2.3, 1.8], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.9, 1.8], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [5.5, 1.8], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [3.1, 2.6], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [4.7, 2.6], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [6.3, 2.6], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [1.5, 2.6], ry: Math.PI / 2, scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'hardwoodfloor', pos: [6.3, 1.8], scale: [0.2, 1, 0.2], y: 0.01 },
      { model: 'officechair', pos: [2, -0.9], ry: -Math.PI / 2, box: [0.8, 0.8] },
      { model: 'desk', pos: [1.5, -0.9], ry: -Math.PI / 2, box: [0.8, 0.8] },
      { type: 'tv', pos: [1.3, -0.9], ry: Math.PI / 2, scale: [1, 1, 0.4], y: 0.1 },
      {
        model: 'bookshelf',
        pos: [1.4, -2.5],
        ry: Math.PI / 2,
        scale: [0.7, 1.1, 1],
        y: 0.1,
        box: [0.8, 0.8],
      },
      { model: 'sidetable', pos: [1.5, 0.4], y: 0.1, box: [0.8, 0.8] },
      { model: 'pottedplant', pos: [1.5, 0.4], scale: [1, 0.8, 0.8], y: 0.7, box: [0.8, 0.8] },
      {
        model: 'wallpanel',
        pos: [1.2, 7.5],
        ry: -Math.PI / 2,
        scale: [2.4, 1.2, 0.1],
        y: -0.1,
        box: [0.8, 0.8],
      },
      {
        model: 'wallpanel',
        pos: [1.2, -3.2],
        ry: -Math.PI / 2,
        scale: [-2.8, 1.2, 0.1],
        y: -0.1,
        box: [0.8, 0.8],
      },
      { model: 'divider', pos: [3.6, 4.1], ry: Math.PI, scale: [2.2, 2.1, 2.7], box: [0.8, 0.8] },
      { type: 'shower', pos: [-1.8, -3.5], scale: [1, 1.5, 1], y: -0.2 },
      { type: 'shower', pos: [-1.8, -6.6], ry: Math.PI / 2, scale: [1.4, 1.5, 1], y: -0.2 },
      { type: 'shower', pos: [-5.3, -3.8], ry: -Math.PI / 2, scale: [1.4, 1.5, 1], y: -0.2 },
      { model: 'glasswindow', pos: [-1.2, -4.9], ry: 0, scale: [0.9, 1.27, 0.9], c: '#ffffff' },
      { model: 'sofa3', pos: [5.2, -0.4], ry: -Math.PI / 2, box: [0.8, 0.8] },
      { model: 'rugStudy', pos: [-3.6, 5.1], ry: Math.PI, scale: [1.5, 1, 2.2], y: 0.01 },
      { model: 'rugStudy', pos: [4.6, -0.2], ry: 0, scale: [0.9, 1, 1.6], y: 0.02, box: [3.2, 2.2] },
      { model: 'coffee', pos: [-5.7, -5.2], ry: Math.PI / 2, scale: [0.9, 3.1, 1.1], box: [1.1, 0.6] },
      { model: 'lamp', pos: [5.4, 1.1], ry: -Math.PI / 2, scale: [1.1, 2.9, 0.9], box: [0.8, 0.8] },
      { model: 'tub', pos: [-4.4, -5.1], ry: -Math.PI / 2, scale: [1.2, 1.6, 1.2], y: 0.1, box: [1.75, 0.8] },
      {
        model: 'wardrobe',
        pos: [-5.6, -3.7],
        ry: Math.PI / 2,
        scale: [1.2, 1.2, 1],
        y: 0.4,
        box: [1.3, 0.62],
      },
      {
        model: 'wardrobe',
        pos: [-5.6, -6.6],
        ry: Math.PI / 2,
        scale: [1.2, 1.2, 1],
        y: 0.5,
        box: [1.3, 0.62],
      },
      { model: 'divider', pos: [-5.7, -3.7], ry: Math.PI / 2, scale: [1.4, 2.7, 2.7], box: [0.8, 0.8] },
      { model: 'divider', pos: [-5.7, -6.6], ry: Math.PI / 2, scale: [1.4, 2.7, 2.7], box: [0.8, 0.8] },
      { model: 'rugBedroom', pos: [-5, -5.1], ry: -Math.PI / 2, scale: [1.3, 1, 1], box: [3.6, 2.6] },
      { type: 'tvwall', pos: [-1.2, -0.3], ry: -Math.PI / 2, scale: [1.1, 0.9, 1], y: 0.1 },
      { model: 'bookshelf', pos: [-2.4, -2.6], scale: [1.3, 1.4, 1], box: [0.8, 0.8] },
      { model: 'wardrobe', pos: [1.5, 5], ry: Math.PI / 2, scale: [1.2, 1.2, 1], y: 0.1, box: [1.3, 0.62] },
      { model: 'shower', pos: [-2.4, -7.1], scale: [1.6, 1.3, 1.2] },
      { model: 'vanity', pos: [-2.05, -3.1], ry: Math.PI, scale: [1, 1.5, 1], box: [0.8, 0.8] },
      { model: 'vanity', pos: [-2.95, -3.1], ry: Math.PI, scale: [1, 1.5, 1], box: [0.8, 0.8] },
      { model: 'curtain', pos: [-2.9, -6.6], ry: 0, scale: [0.5, 1.18, -0.3], y: -0.2 },
      { model: 'curtain', pos: [-1.8, -6.6], ry: 0, scale: [0.5, 1.18, -0.3], y: -0.2 },
      { model: 'coffee', pos: [3.8, -0.3], ry: Math.PI / 2, scale: [1.4, 1.6, 1.5], box: [1.1, 0.6] },
      { type: 'mirror', pos: [-5.9, -5.2], ry: -Math.PI / 2, scale: [0.7, 1, 1], y: 0.5 },
      { type: 'pendant', pos: [-2, -4], ry: Math.PI / 2, y: 0.8 },
      { type: 'pendant', pos: [-3.1, -4], ry: Math.PI / 2, y: 0.8 },
      { type: 'pendant', pos: [-5.2, -5.2], ry: Math.PI / 2, y: 0.4 },
      { model: 'art', pos: [5.9, 0.57], ry: -Math.PI / 2, scale: [1.7, 1.5, 1], y: 1.3, box: [0.8, 0.8] },
      { model: 'art', pos: [5.9, 1.58], ry: -Math.PI / 2, scale: [1.7, 1.5, 1], y: 1.3, box: [0.8, 0.8] },
      {
        model: 'wallpanel',
        pos: [5.99, -0.6],
        ry: -Math.PI / 2,
        scale: [-1.8, 1.2, 0.1],
        y: -0.1,
        box: [0.8, 0.8],
      },
      {
        model: 'wallpanel',
        pos: [5.99, 4.8],
        ry: -Math.PI / 2,
        scale: [1.7, 1.2, 0.1],
        y: -0.1,
        box: [0.8, 0.8],
      },
      { model: 'art', pos: [5.9, 2.75], ry: -Math.PI / 2, scale: [1.7, 1.5, 1], y: 1.3, box: [0.8, 0.8] },
      { model: 'art', pos: [5.9, 3.7], ry: -Math.PI / 2, scale: [1.7, 1.5, 1], y: 1.3, box: [0.8, 0.8] },
      { model: 'chair', pos: [5.1, -2.5], ry: -1.33, box: [0.8, 0.8] },
      { model: 'fridgestocked', pos: [-6, 2.9], ry: Math.PI / 2, scale: [0.5, 0.5, 0.8], box: [0.8, 0.8] },
    ],
    stations: [],
  },
};

// Canonical tier name from any room-type name ("Deluxe King" → "Deluxe").
export function canonicalTier(typeName = '') {
  const t = String(typeName).toLowerCase();
  if (t.includes('presidential')) return 'Presidential';
  if (t.includes('suite')) return 'Suite';
  if (t.includes('deluxe')) return 'Deluxe';
  return 'Standard';
}

// ── The shared layout store ─────────────────────────────────────────────────
//
// Layouts used to be autosaved to THIS BROWSER's localStorage, which meant the
// room you saw depended on the machine you sat at: two people editing the same
// tier saw different rooms, and a layout died with the browser profile. There is
// now exactly one layout per tier, held by the auth service and fetched once at
// start-up (see layoutSync.js).
//
// This module stays free of network code on purpose — `scripts/check-room-layouts.mjs`
// and the node --test suites import it directly, and neither has a browser or an
// axios instance. Hydration is pushed IN from layoutSync.js instead.
const serverLayouts = new Map();

/**
 * Replace the live layouts with what the server holds. Tiers the server has no
 * row for keep the layout committed in this file, so the code remains the
 * default and the database is the override.
 *
 * @param {Array<{roomTier: string, room: object, furniture: array, walls: array, stations: array}>} rows
 */
export function setRoomLayouts(rows) {
  serverLayouts.clear();
  for (const r of rows || []) {
    if (!r || !r.room || !Array.isArray(r.furniture)) continue; // ignore a malformed row
    // An EXACT tier key, deliberately not canonicalTier(): that function falls
    // back to 'Standard' for anything it does not recognise, so a row with a
    // junk roomTier would silently replace the Standard layout.
    const tier = r.roomTier;
    if (!Object.prototype.hasOwnProperty.call(LAYOUTS, tier)) continue;
    serverLayouts.set(tier, r);
  }
}

/** True once the server's layouts have been applied. */
export function hasServerLayouts() {
  return serverLayouts.size > 0;
}

/** The stored layout for a tier, or null when the committed one is in force. */
export function storedLayoutFor(typeName = '') {
  return serverLayouts.get(canonicalTier(typeName)) || null;
}

// Map a room-type name to a plan: the shared stored layout if there is one,
// otherwise the layout committed in this file. The returned object is always
// plan-shaped, so every consumer (RoomFreeRoam geometry, collision, station
// markers, the scenario overlay) needs no other change.
export function getRoomPlan(typeName = '') {
  const tier = canonicalTier(typeName);
  const base = LAYOUTS[tier];
  const ov = serverLayouts.get(tier);
  if (!ov) return base;
  return {
    ...base,
    w: ov.room.w ?? base.w,
    l: ov.room.l ?? base.l,
    h: ov.room.h ?? base.h,
    floor: ov.room.floor ?? base.floor,
    spawn: ov.room.spawn ?? base.spawn,
    furniture: ov.furniture,
    walls: ov.walls || [],
    // An authored layout may deliberately have no stations (they were removed on
    // purpose), so an empty array is honoured rather than treated as "unset".
    stations: Array.isArray(ov.stations) ? ov.stations : base.stations,
  };
}

export { LAYOUTS };
