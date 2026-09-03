# Phase 3 — The 3D room

Closes D1, D2, D3, D4, D5, D6, D7, D8. Models went **1011 MB → 44 MB**
(16.9M → 2.9M triangles), and all four tiers now pass a layout validator that
checks 3D geometry rather than only 2D footprints.

---

## ⚠️ One thing to know before you delete anything

`.attic/models-uncompressed-originals/` is now the **only copy** of your original
3D assets (~1.0 GB). The models in `web/public/models/` are lossily compressed —
meshes simplified, textures re-encoded to WebP and capped at 1024px. Read
`.attic/README.md`: it tells you exactly which subdirectories are safe to delete
and which one isn't.

Regenerate the compressed set at any time with `bash scripts/optimize-models.sh`
(it stages to a separate directory and never overwrites in place).

---

## The scaler was the single highest-impact defect (D1)

`task3d.jsx` scaled every model uniformly off its **horizontal** footprint:

```js
if (fitWidth) s.scale.setScalar(fitWidth / (Math.max(size.x, size.z) || 1));
```

These are Meshy-AI image-to-3D exports with no metric basis, so height came out as
whatever each asset's native aspect ratio happened to be. There are now three fit
modes — `fitSize` (per-axis) → `fitHeight` (uniform, on Y) → `fitWidth` (the old
behaviour) — and **height is the default**, because height is what reads as wrong
in an interior.

`fitSize` exists because for some fixtures *no* uniform scale can be correct.
Rugs prove it: `Bedroom Area Rug` is natively 0.676 × 0.900 × 0.107, so a uniform
scale making it 3.6 m wide makes it 4.8 m **tall**, and one making it 2 cm thick
makes it 1.5 cm wide.

Every value in `MODEL_CFG` was derived from measured native dimensions, not
guessed — `node scripts/measure-models.mjs` prints the table. Verified in-browser:

| Fixture | Before | After | Target |
|---|---|---|---|
| King bed | 2.40 × **1.01** × 2.39 | 1.95 × **0.55** × 2.05 | ✅ |
| Bedroom rug | 3.60 × **4.79** × 0.57 | 3.60 × **0.02** × 2.60 | ✅ |
| Vanity | 2.00 × **2.37** × 0.70 | 1.60 × **1.90** × 0.56 | ✅ |
| City backdrop | 7.0 × **4.53** × 0.32 | 7.0 × **2.40** × 0.12 | ✅ |
| Slat wall | 2.60 × **3.16** × 0.28 | 1.97 × **2.40** × 0.21 | ✅ |
| Nightstand | **2.6 m wide** | **0.59 m** | ✅ |

That nightstand was `MODEL_CFG.nightstand = { w: 2.6 }` — a 2.6 **metre** wide
nightstand, and the default the editor palette handed you. Both `city` backdrops
now share a height, which is what makes the corner window wrap line up; they used
to render 4.53 m and 2.72 m tall from the same asset.

Two measurements the audit didn't have: **Silver Pod Wall is natively
65.4 × 6.0 × 50.0 m**, and Hardwood Floor is 2 cm across.

## Three of four tiers had zero models (D2)

Standard, Deluxe and Suite were **78 fixtures of `RoundedBox` with flat hex
colours** between them, while ~13 registered `.glb` assets went unused and every
rug was a grey-blue `planeGeometry`. All three now use real models for beds,
nightstands, wardrobes, sofas, desks, chairs, vanities, tubs, toilets, showers,
minibars, plants and rugs.

## Real image-based lighting, without a CDN (D3)

`meshStandardMaterial` with no environment map gets **no specular reflection at
all** — which is why everything read as matte plastic, and why the gold WallArt
rings (metalness 0.85) and chrome faucets (0.6–0.7) rendered as near-black
smudges: a metal has no diffuse term, so it had nothing to reflect.

The room now has an `<Environment>` built from `<Lightformer>` emitters — a
ceiling bounce, cool daylight from the window wall, warm side fill, and a floor
bounce. Deliberately **not** `<Environment preset="apartment">`: drei's presets
fetch an HDR from `raw.githack.com` at runtime, which would make the 3D room
depend on external network access. Same reasoning as the compression choice below.

Tone mapping is set explicitly (ACES Filmic, exposure 1.15) since exposure now has
to compensate for much lower ambient fill.

## Lighting and shadows (D4)

Fill was `ambient 0.66 + hemi 0.4` = **1.06 of direction-free light** against 1.3
of directional — about 45% of the room's light carried no shape information, which
is the main reason it read flat. With real IBL doing the ambient work those drop to
**0.18 / 0.15**.

- **The ceiling and all four walls now receive shadows.** None of them did, so no
  vertical surface ever showed a shadow, and an interior with shadows only on the
  floor always reads as fake. They deliberately do *not* cast — the shell is a
  sealed box with no window openings, so a shadow-casting ceiling would black out
  the room.
- **The shadow frustum is sized to the room.** It was hardcoded to ±10 m whether
  the room was 6.4×8 or 12×15, so a Standard spent most of its shadow map on empty
  space outside the walls while a Presidential was clipped. This is a bigger
  quality win than resolution.
- `shadow-normalBias` / `shadow-bias` added — there were no bias settings at all,
  hence acne and peter-panning.
- `<ContactShadows>` was `scale = max(W,L)+4` (19 m on Presidential) at drei's
  default 512 = 3.7 cm/texel with blur 2.6, i.e. grey mush. Now room-sized at
  1024 with blur 1.6 — and moved **below** the rugs, which sit at y=0.012; it used
  to float above them at y=0.02.

## `fov: 70` → `58` (D8)

70 gives strong edge stretching and reads like a fisheye corridor; 55–58 is the
norm for architectural first-person.

## Arrangement: placement is now computed, not typed (D5)

Positions were hand-typed and wrong in ways a 2D footprint check couldn't see.
Every wall-hugging fixture is now placed with `atBack/atFront/atLeft/atRight`
helpers that take the fixture's **rendered** footprint and return the centre
coordinate putting its back face on the wall. Fixed:

- Standard bed 29 cm off its headboard wall, nightstands floating 45 cm out,
  Suite bed 70 cm out, Presidential sofa 50 cm off its accent wall — all flush now.
- **Presidential `deckTub` clipped 14 cm into the bathroom wall** and the
  **`toilet` passed straight through one** — both re-flushed to the enclosure's
  interior faces.
- **The wardrobe was 90° out**, protruding 1.2 m into the room on a 0.6 m contact
  face with its doors pointing sideways. Now rotated so its depth meets the wall.
- **Two mirrors per vanity.** The vanity model has its own integral mirror, and
  every layout added a second one on top of it. The extra mirrors are gone.
- **Duplicate lamps** at identical coordinates in Deluxe and Suite (z-fighting
  plus a doubled `pointLight`) — one lamp per nightstand now.
- **The Presidential "Wet Bar" station was a glowing ring on bare floor** — there
  was no wet bar fixture anywhere in that layout. There is now.
- `slatwall` had `wall: true` and no `box`, making it a 3.16 m freestanding screen
  the player walked **through**. Now a correctly-sized 2.4 m screen with collision.
- `bath` and `bath2` were 1.8 m apart, inside the 2.4 m proximity radius, so only
  the nearer was ever promptable from between them. Now well separated.

## The validator gave false confidence — it doesn't any more (D6)

`scripts/check-room-layouts.mjs` printed `✅ ALL TIERS CLEAN` on the room described
above, because it only ever checked **2D gameplay footprints**. It now also checks:

- rendered height against the ceiling, and that fixtures sit on the floor;
- collision `box` vs rendered footprint (what you see and what you bump into must
  be the same object);
- fixtures intersecting the room shell or an interior wall;
- case goods actually flush to a wall (room **or** interior — a bathroom vanity
  flush to the enclosure is correct even if it's 0.5 m from a room wall);
- wall-mounted items having a mount height;
- duplicate placements.

It also **no longer exempts Presidential from adjacency checking**. The old code
had `name === 'Presidential' ? null`, which is exactly how the wet-bar-with-no-wet-bar
got through.

Rendered sizes come from `web/src/sim/modelSizes.js` applied to measured natives in
`scripts/model-metrics.json` — the same math `task3d.jsx` uses, so the validator
reasons about what actually renders. `node scripts/check-room-layouts.mjs --sizes`
prints every fixture's rendered extent and its flush-at coordinates.

Now wired into CI **and** the pre-commit hook for changes to `roomLayouts.js`
*or* `modelSizes.js` — a sizing edit alone can push a fixture through a wall.

## 1011 MB → 44 MB (D7)

`bash scripts/optimize-models.sh`: meshopt + WebP textures (max 1024px) + mesh
simplification.

| | Before | After |
|---|---|---|
| Total | 1011 MB | **44 MB** |
| Triangles | 16,887,046 | **2,901,719** |
| Textures | 420 MB | **4 MB** |
| Compressed | 0/41 | **41/41** |

Worst offenders were a folded towel at 1,938,955 triangles and a potted plant at
1,069,623 with a 9.9 MB JPEG.

**meshopt, not Draco, on purpose.** drei's `useGLTF` enables both decoders, but its
Draco path fetches the decoder from `https://www.gstatic.com/draco/…` at runtime —
every model load would depend on a Google CDN, bad on a school network and broken
offline. The meshopt decoder ships inside `three` itself. Textures are WebP rather
than KTX2 for the same reason (KTX2 needs a transcoder served alongside the app).

**A bug this surfaced:** `useGLTF` re-runs its `extensions` callback per URL, so it
called `MeshoptDecoder()` afresh for each model. Instantiating ~20 decoders in
parallel wedges them — every model stayed suspended forever and each `<Model>`
rendered its procedural fallback, so the room came up empty. `task3d.jsx` now
registers **one** shared decoder and passes `useDraco = false`.

`web/dist` is now **57 MB** (was 1.0 GB).

---

## Verified

- **`node scripts/check-room-layouts.mjs` → ✅ ALL TIERS CLEAN** on both the
  gameplay and 3D checks. It reported 39 real defects against the pre-Phase-3
  layouts, including every D5 item.
- **Runtime measurement in the browser.** Each model was loaded, its *decoded*
  bounding box measured, and the fit math applied. Two results:
  1. Compression is dimensionally lossless — decoded natives match the
     pre-compression measurements to three decimals (bed 1.187 vs 1.188).
  2. Every fixture renders at exactly its intended size, matching the `FP` table
     in `roomLayouts.js`.
- **Live scene probe.** All 21 Standard fixtures present and correctly placed —
  bed 1.95×0.55×2.05 flush at z −3.0, nightstands 0.59³, rug 3.60×**0.02**×2.60,
  lamps at y 0.56–0.98 resting on nightstands that top out at 0.55, everything
  under the 3 m ceiling.
- Screenshots of the rendered rooms; `npm run build` clean.

**Not verified:** frame rate under load, and the room as reached through the real
app (it sits behind auth on the Housekeeping page and the Docker daemon was not
running). The verification above used a temporary standalone harness.

## Still open

- **D9 — the layout editor doesn't match the game view.** Not in Phase 3's scope;
  `RoomLayoutEditor.jsx` still uses different light values and omits the front wall
  and ceiling, so you tune the room in a view that doesn't match the render.
- **Model load time.** 2.9M triangles across 23 models takes several seconds to
  decode on first entry to a Presidential suite, with each `<Model>` showing its
  fallback until it resolves. A loading gate would be better than furniture
  popping in. Lowering `--simplify-error` in `optimize-models.sh` would trade
  quality for speed.
- **`Bathroom3D.jsx` still asks for `modelKey="sink"`**, which is not a key in
  `MODELS` (it's `vanity`), so that sink stays a procedural box. That's G11 —
  Phase 4.
- The four `ChecklistTask` stations, vacuuming, the timer, fail states and result
  persistence are all Phase 4.
