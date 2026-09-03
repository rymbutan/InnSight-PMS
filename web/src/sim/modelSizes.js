// ─────────────────────────────────────────────────────────────────────────────
// Fixture sizing — the single source of truth for how big things are in the room.
//
// This is a plain .js module (no React, no three) ON PURPOSE: both the running app
// and `scripts/check-room-layouts.mjs` import it. The validator has to know the
// RENDERED size of every fixture to check heights, ceiling clipping and
// collision-vs-visual mismatch, and it cannot import a .jsx file.
//
// Model key → filename lives here too, so the layout validator can resolve a key
// to its measured native dimensions in scripts/model-metrics.json.
// ─────────────────────────────────────────────────────────────────────────────

// Fixture key → .glb basename in web/public/models/.
export const MODEL_FILES = {
  // Legacy keys used by Standard/Deluxe/Suite + renderFix fallbacks.
  sofa: 'White Three Seater',
  chair: 'Gray Armchair',
  plant: 'Decorative Potted',
  lamp: 'Mid Century Desk Lamp',
  vase: 'Potted White Orchid',
  // Presidential suite fixtures
  bed: 'King Platform Bed',
  nightstand: 'Circular Side Table', // no dedicated nightstand asset → side table
  wardrobe: 'Custom Wooden Wardrobe',
  tv: 'Wall Mounted TV',
  desklamp: 'Mid Century Desk Lamp',
  sofa3: 'White Three Seater',
  armchair: 'Gray Armchair',
  accentchair: 'Side Accent Chair Woven',
  coffee: 'Light Wood Coffee Table',
  sidetable: 'Circular Side Table',
  ottoman: 'Circular Side Table', // no ottoman asset → low side table stand-in
  divider: 'Wooden Bench Room Divider',
  desk: 'Desk Slate Design',
  officechair: 'Blue Mesh Office Chair',
  vanity: 'Bathroom Vanity Double',
  shower: 'Glass Shower Enclosure',
  tub: 'Grey Marble Bathtub',
  toilet: 'Modern White Toilet',
  towelrack: 'Chrome Double Towel',
  towel: 'Folded White Towel',
  towelstack: 'Stacked Folded Towel',
  orchid: 'Potted White Orchid',
  art: 'Framed Landscape Art',
  walldeco: 'Dark CircleWall Deco',
  sculpture: 'Silver Pod Wall',
  ceilingspot: 'Recessed Ceiling Spot',
  city: 'City Skyline Backdrop',
  slatwall: 'Vertical Wood Slate Wall',
  bookshelf: 'Bedroom Bookshelf',
  hardwoodfloor: 'Hardwood Floor',
  window: 'Floor to Ceiling Wind',
  curtain: 'Sheer Hotel Curtain',
  minibar: 'Hotel Minibar Wet Bar',
  wallpanel: 'Hotel Wall Panel Grey',
  foyer: 'Entrance Foyer',
  rugBedroom: 'Bedroom Area Rug',
  rugLiving: 'Living Room Area Rug',
  rugStudy: 'Study Area Rug',
  covelight: 'Ceiling Cove Lighting',
  pottedplant: 'Decorative Potted',
  woodring: 'Cylindrical Wood Ring',
  // ── Scenario / fault assets (added 2026-08-29) ──
  // Registering a key here is all it takes for a model to appear in BOTH editor
  // palettes: MODELS is derived from this map and both editors enumerate it.
  bedplain: 'bed',
  messybed: 'messy_bed',
  messybed2: 'messy bed 1',
  dirtymattress: 'dirtymatress',
  unmadesofabed: 'Meshy_AI_Unmade_Sofa_Bed_0829110246_texture',
  towelfloor: 'towelonthefloor',
  dirtysink: 'dirtysink',
  dirtytoilet: 'dirtytoilet',
  dishes: 'dishes',
  trashcan: 'trash can',
  cleaningcart: 'cleaning cart',
  cleaningsupply: 'cleaning supply',
  clutterpile: 'Meshy_AI_the_object_is_a_pile__0829110202_texture',
  fridgeempty: 'Refrigerator_nofood',
  fridgestocked: 'redbull ref',
  rat: 'Meshy_AI_A_dirty_rat_that_woul_0829110139_texture',
  canA: 'Meshy_AI_Ultra_realistic_alumi_0829105331_texture',
  canB: 'Meshy_AI_Ultra_realistic_alumi_0829105401_texture',
  toiletry: 'Meshy_AI_Create_a_realistic_3D_0829105345_texture',
  // ── Second batch (2026-08-29 evening) ──
  kitchenette: 'Meshy_AI_Warm_Walnut_Kitchen_0829140615_texture',
  playkitchen: 'Meshy_AI_Wooden_Play_Kitchen_0829135913_texture',
  // These two sat unregistered on disk — shipping in every build but reachable
  // from no palette. They are NOT duplicates of `woodring` / `divider`: different
  // hashes and different geometry, so they are alternates, not dead copies.
  woodring2: 'Meshy_AI_Cylindrical_Wood_Ring_0628102149_image-to-3d-texture',
  divider2: 'Wooden room divider',
  // ── Third batch (2026-08-29) ──
  // Hand-modelled low-poly, unlike the Meshy exports: 160 and 2,828 triangles at
  // 14 KB / 113 KB. They carry KHR_materials_transmission for real glass, so they
  // need no compression pass — but note that material extensions are NOT geometry
  // compression, and a raw asset carrying them can look 'already optimised'.
  glasswindow: 'glass_window',
  slidingdoor: 'sliding_door',
};

// Per-model fit transforms for the legacy Std/Deluxe/Suite fixture keys.
// `h` = real-world height in metres (see MODEL_CFG for why height, not width).
export const MODEL_TF = {
  sofa: { h: 0.85, ry: Math.PI }, // White Three Seater — native 2.26×0.85×0.95, already metric
  chair: { h: 0.9, ry: 0 }, // Gray Armchair — native 1.06×0.90×0.84, already metric
  plant: { h: 0.9, ry: 0 }, // Decorative Potted — native 0.17×0.24×0.17, needs 3.75×
  lamp: { h: 0.42, ry: 0 }, // table lamp — sits ON the nightstand, not the floor
  vase: { h: 0.32, ry: 0 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Real-world size per .glb model key.
//
//   { h: n }            fit HEIGHT to n metres (uniform scale)   ← the default
//   { w: n }            fit max(x,z) to n metres (uniform scale)
//   { size: [x,y,z] }   fit each axis independently (non-uniform)
//
// WHY HEIGHT IS THE DEFAULT
// -------------------------
// Every entry here used to be `{ w }`, and the loader scaled uniformly off the
// horizontal footprint — so height came out as whatever each asset's native
// aspect ratio happened to be. These are Meshy-AI image-to-3D exports with no
// metric basis at all, so the results were wild: a 4.8 m tall rug, a 2.37 m
// vanity, a king bed rendering as a 1 m tall square. Height is what reads as
// wrong in an interior, so it is now the authoritative axis for most fixtures.
//
// Values below are chosen from each model's MEASURED native size — run
// `node scripts/measure-models.mjs` to reproduce the table. A few are already
// correctly metric (sofa3, desk, minibar, officechair scale by ~1.0); most are
// not.
//
// `size` is reserved for fixtures where NO uniform scale can work — rugs (flat
// and wide) and the window backdrops (metres of wall, 2.4 m tall). See task3d.jsx.
//
// Override per-fixture in a layout with `h` / `w` / `size`; the layout's value
// wins. Facing (`ry`), placement height (`y`) and wall-mount (`wall`) come from
// the layout item too.
// ─────────────────────────────────────────────────────────────────────────────
export const MODEL_CFG = {
  // ── Bedroom ──
  // King Platform Bed: native 1.188 × 0.500 × 1.181 — a near-square footprint, so
  // no uniform scale yields both a 1.9 m width and a 0.55 m height. A bed is read
  // by its footprint, and it is boxy enough to take per-axis scaling cleanly.
  bed: { size: [1.95, 0.55, 2.05] },
  // was `{ w: 2.6 }` — a 2.6 METRE wide nightstand, and the default the editor
  // palette handed you. Circular Side Table, native 0.534³.
  nightstand: { h: 0.55 },
  wardrobe: { size: [1.3, 2.25, 0.62] }, // native 2.14×2.00×0.39 — too shallow to fit uniformly
  tv: { w: 1.25 }, // width-defined: native 16:9.7, close enough to fit on width
  desklamp: { h: 0.45 },
  bookshelf: { h: 2.1 },
  // ── Lounge ──
  sofa3: { h: 0.85 }, // native 2.26×0.85×0.95 — already metric, scales ~1.0
  armchair: { h: 0.9 },
  accentchair: { h: 0.78 },
  coffee: { size: [1.1, 0.42, 0.6] }, // native y 0.75 is table-height, not coffee-height
  sidetable: { h: 0.55 },
  ottoman: { h: 0.42 },
  divider: { h: 0.45 }, // Wooden Bench Room Divider — bench height, native is right
  // ── Office ──
  desk: { h: 0.75 }, // native 1.55×0.75×0.58 — already metric
  officechair: { h: 1.05 },
  // ── Bathroom ──
  // Bathroom Vanity Double, native 1.263 × 1.500 × 0.444. The 1.5 m height is the
  // cabinet PLUS its integral mirror, so fit the whole assembly to 1.9 m and the
  // cabinet lands at hip height. (The layouts also used to add a SECOND mirror on
  // top of this one — removed.)
  vanity: { h: 1.9 },
  shower: { h: 2.05 },
  tub: { size: [1.75, 0.58, 0.8] }, // native 1.34 long — too short to fit uniformly
  toilet: { h: 0.78 }, // native 0.35×0.80×0.65 — already metric
  towelrack: { w: 0.6 }, // native 0.46×0.06×0.14 — a bar; width-defined
  towel: { w: 0.32 },
  towelstack: { h: 0.3 },
  // ── Décor ──
  orchid: { h: 0.5 }, // native 0.29×0.50×0.24 — already metric
  // Framed Landscape Art is natively PORTRAIT (0.289 w × 0.600 h). Forcing it
  // landscape would stretch it 3×; it reads fine as a portrait piece instead.
  art: { h: 0.75 },
  walldeco: { w: 2.0 }, // native 0.10×0.03×0.002 — a disc; width-defined
  // Silver Pod Wall is natively 65.4 × 6.0 × 50.0 m (!). Not placed in any layout;
  // fit on width so it at least appears at a sane size if someone adds it.
  sculpture: { w: 1.2 },
  ceilingspot: { w: 0.18 },
  covelight: { w: 3.0 },
  woodring: { h: 0.35 },
  pottedplant: { h: 0.9 },
  // ── Architectural ──
  // City Skyline Backdrop, native 0.464 × 0.300 × 0.021. Must span metres of wall
  // while staying window-height, so per-axis is the only option. BOTH backdrops
  // now share a height, which is what makes the corner window wrap line up — they
  // used to render 4.53 m and 2.72 m tall from the same asset.
  city: { size: [7, 2.4, 0.12] },
  slatwall: { h: 2.4 }, // was rendering 3.16 m, clipping ceiling AND floor
  window: { size: [3.0, 2.4, 0.15] },
  curtain: { h: 2.6 },
  minibar: { h: 2.1 }, // native 1.13×2.10×0.66 — already metric
  wallpanel: { h: 2.6 },
  foyer: { size: [2.2, 0.78, 0.45] },
  hardwoodfloor: { size: [4, 0.02, 4] },
  // ── Rugs — flat and wide; uniform scaling is impossible here ──
  rugBedroom: { size: [3.6, 0.02, 2.6] },
  rugLiving: { size: [3.6, 0.02, 2.6] },
  rugStudy: { size: [3.2, 0.02, 2.2] },
  // ── Scenario / fault assets ──
  // THREE of these are non-metric Meshy exports whose native bounding boxes are
  // in the HUNDREDS of metres — bed 290×83×241, messybed2 250×90×216, messybed
  // 134×95×218. With no entry here they inherit the loader's default and render
  // as buildings, so each is pinned per-axis the way `bed` already is. The rest
  // measured close to real-world size and take a uniform fit.
  bedplain: { size: [1.95, 0.55, 2.05] },
  messybed: { size: [1.95, 0.7, 2.05] },
  messybed2: { size: [1.95, 0.7, 2.05] },
  dirtymattress: { size: [1.4, 0.28, 1.9] }, // native 1.51×0.30×1.07 — too short in z to fit uniformly
  unmadesofabed: { h: 0.8 }, // native 1.65×0.80×1.64 — already metric
  towelfloor: { w: 0.7 }, // native 0.83×0.12×0.85
  dirtysink: { w: 0.55 },
  dirtytoilet: { h: 0.75 }, // matches the clean `toilet` so a swap reads as the same fixture
  dishes: { w: 0.28 },
  trashcan: { h: 0.4 },
  cleaningcart: { h: 1.1 }, // native 1.27×1.10×0.55 — already metric
  cleaningsupply: { h: 0.35 },
  clutterpile: { w: 0.9 }, // native 1.02×0.30×1.07
  fridgeempty: { h: 0.85 }, // native 0.90×0.85×0.61 — already metric
  fridgestocked: { h: 1.8 }, // native 1.12×1.80×1.11 — already metric
  rat: { w: 0.18 }, // native 0.04×0.05×0.15 — already metric
  canA: { h: 0.12 },
  canB: { h: 0.12 },
  toiletry: { h: 0.12 },
  // ── Second batch ──
  kitchenette: { h: 2.4 }, // native 3.57×2.40×3.54 — already metric, a full corner unit
  // native 0.099×0.120×0.037 — a miniature export, ~10cm across. Fitting height
  // to 1 m gives a ~0.83 × 1.0 × 0.31 unit, which is child's-play-kitchen scale.
  playkitchen: { h: 1.0 },
  woodring2: { w: 1.4 }, // native 1.47×0.75×0.98
  divider2: { h: 1.5 }, // native 0.84×1.50×0.17
  // native 0.10×4.10×2.89 — 4.1 m tall would punch through a 3 m ceiling, so it is
  // fitted by height. Uniform, since a glass pane distorts visibly if stretched.
  glasswindow: { h: 2.4 },
  slidingdoor: { h: 2.1 }, // native 1.95×2.21×0.16 — already realistic
};

// Resolve which fit mode a fixture uses. A value set on the LAYOUT ITEM always
// wins over the MODEL_CFG default, whichever axis it names — otherwise a layout
// that says `w: 2.4` would be silently overruled by a config default of `h`.
// Within each source the order is size → height → width.
export function fitPropsFor(item) {
  const cfg = MODEL_CFG[item.model] || {};
  if (item.size) return { fitSize: item.size };
  if (item.h) return { fitHeight: item.h };
  if (item.w) return { fitWidth: item.w };
  if (cfg.size) return { fitSize: cfg.size };
  if (cfg.h) return { fitHeight: cfg.h };
  if (cfg.w) return { fitWidth: cfg.w };
  return {};
}

// Rendered [x, y, z] extent of a model fixture, given its native size. Mirrors the
// scaling in task3d.jsx <Gltf> exactly — that correspondence is what lets the
// layout validator reason about the room in 3D without a GPU.
export function renderedSize(item, native) {
  if (!native) return null;
  const [nx, ny, nz] = native;
  const fit = fitPropsFor(item);
  if (fit.fitSize) return [...fit.fitSize];
  let k = 1;
  if (fit.fitHeight) k = fit.fitHeight / (ny || 1);
  else if (fit.fitWidth) k = fit.fitWidth / (Math.max(nx, nz) || 1);
  return [nx * k, ny * k, nz * k];
}

// Height and depth of the PROCEDURAL (non-.glb) fixtures, for the same validation.
//
// These mirror the geometry in RoomFreeRoam.jsx `renderFix()`. They are a hand-kept
// table because that geometry is JSX, not data — if you change a case in renderFix,
// update the matching row here. `h` is the topmost extent above y=0; `sits` marks
// fixtures that are meant to rest on another surface rather than the floor.
export const TYPE_EXTENTS = {
  bed: { h: 1.35 },
  twin: { h: 0.72 },
  nightstand: { h: 0.56 },
  sofa: { h: 0.87 },
  coffee: { h: 0.47 },
  desk: { h: 0.77 },
  chair: { h: 0.73 },
  minibar: { h: 1.2 },
  wetbar: { h: 1.33 },
  wardrobe: { h: 2.0 },
  walkin: { h: 2.3 },
  vanity: { h: 2.0 },
  twinvanity: { h: 2.13 },
  tub: { h: 0.63 },
  deckTub: { h: 0.66 },
  toilet: { h: 0.85 },
  shower: { h: 2.1 },
  dining: { h: 0.49 },
  counter: { h: 0.95 },
  console: { h: 0.55 },
  tv: { h: 1.5 },
  tvwall: { h: 3.0 },
  plant: { h: 0.9 },
  lamp: { h: 0.98, sits: true },
  pendant: { h: 2.8, hangs: true },
  wallart: { h: 2.15, wall: true },
  mirror: { h: 2.35, wall: true },
  panel: { h: 2.6, wall: true },
  drape: { h: 3.0, wall: true },
  rug: { h: 0.012 },
  balcony: { h: 1.03 },
};
