import { Component, Suspense, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as THREE from 'three';
import { MODEL_FILES, fitPropsFor } from './modelSizes';

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0 — shared framework for first-person 3D tasks.
//
// Each 3D task is "scene + interactions" only; this module supplies:
//  • <Task3DScene> — Canvas + lighting/shadows + a FIXED first-person camera
//    with a SMALL look-around (drag to glance; you don't walk inside a task —
//    walking is the free-roam hub's job) + the HTML chrome (instructions,
//    openable SOP reference, coach hint, tool bar). The task swaps to its own
//  • <Model> — loads a registered .glb, else renders procedural placeholder
//    geometry (passed as `fallback`). Registry lives in MODELS below.
//  • GLBoundary — error boundary so a 3D task can fall back to its 2D version.
//
// IMPORTANT: only ONE <Canvas> may be mounted at a time (two WebGL contexts =
// "Context Lost"). The free-roam room already unmounts itself while a task
// panel is open, so a 3D task is the sole live context.
// ─────────────────────────────────────────────────────────────────────────────

// Drop .glb files in web/public/models/ and map fixture keys in
// modelSizes.js → MODEL_FILES (see src/sim/models/README.md). A fixture key with
// no entry there falls back to its procedural placeholder geometry.
//
// These live in public/ rather than src/ deliberately. Vite treats a
// `new URL('./x.glb', import.meta.url)` reference inside src/ as an asset to
// process: `vite build` copies every one into dist/assets under a content-hashed
// name, so a 1 GB model set becomes 2 GB of build. (That is literally how 41
// hashed .glb duplicates ended up committed inside src/sim/models — see
// Phase 2 of the findings report.) Files under public/ are served verbatim at
// their own path and copied once, untouched, at build time.
//
// BASE_URL keeps this correct if the app is ever served from a sub-path.
// encodeURIComponent is required because the filenames contain spaces.
const glb = (name) => `${import.meta.env.BASE_URL}models/${encodeURIComponent(name)}.glb`;

// Fixture key → URL, built from the shared key→filename map. The map lives in
// modelSizes.js so `scripts/check-room-layouts.mjs` can resolve a key to its
// measured native dimensions without importing this .jsx module.
export const MODELS = Object.fromEntries(Object.entries(MODEL_FILES).map(([key, file]) => [key, glb(file)]));

// ── Model decoding ───────────────────────────────────────────────────────────
// The models are meshopt-compressed (see scripts/optimize-models.sh: 1011 MB →
// 44 MB), so GLTFLoader needs a meshopt decoder. Two reasons not to leave that to
// drei's defaults:
//
//  1. `useGLTF(url)` re-runs its `extensions` callback for every URL, calling
//     `MeshoptDecoder()` afresh each time. Instantiating ~20 decoders in parallel
//     wedges them — every model stayed suspended forever, so each <Model> showed
//     its procedural fallback (or nothing) and the room rendered empty. ONE shared
//     decoder instance for all models fixes it.
//  2. drei also registers a DRACOLoader pointed at `https://www.gstatic.com/draco/…`
//     by default. Nothing here is Draco-compressed, and depending on a Google CDN
//     to load furniture would break offline and on a locked-down school network.
//     Passing `useDraco = false` removes that entirely.
//
// The decoder module ships inside `three` itself, so this adds no dependency.
const withMeshopt = (loader) => loader.setMeshoptDecoder(MeshoptDecoder);

// Loads a .glb and scales it to real-world size.
//
// THE BUG THIS FIXES
// ------------------
// The scaler used to be `scale = fitWidth / max(size.x, size.z)` — a UNIFORM scale
// derived from the horizontal footprint only. Since these are Meshy-AI
// image-to-3D exports with arbitrary non-metric proportions, that left height as
// whatever each asset's native aspect ratio happened to be. Measured (see
// `node scripts/measure-models.mjs`):
//
//   King Platform Bed   native 1.188 × 0.500 × 1.181, fitWidth 2.4
//                       → rendered 2.40 × 1.01 × 2.39   a 1 m tall square bed
//   Bedroom Area Rug    native 0.676 × 0.900 × 0.107, fitWidth 3.6
//                       → rendered 3.60 × 4.79 × 0.57   a rug 4.8 m tall
//   Bathroom Vanity     native 1.263 × 1.500 × 0.444, fitWidth 2.0
//                       → rendered 2.00 × 2.37 × 0.70   a 2.37 m tall vanity
//
// THE FIX
// -------
// Three fit modes, in precedence order:
//
//   fitSize:   [x, y, z]  non-uniform — each axis scaled to its own target
//   fitHeight: metres     uniform, keyed on Y
//   fitWidth:  metres     uniform, keyed on max(x, z)   (the old behaviour)
//
// `fitHeight` is the right default for furniture, because height is the dimension
// people read as wrong in an interior — a bed is knee-high, a vanity is hip-high,
// a wardrobe is nearly ceiling-high.
//
// `fitSize` exists because for some fixtures NO uniform scale can be correct, and
// rugs prove it: `Bedroom Area Rug` is natively 0.676 × 0.900 × 0.107, so a
// uniform scale that makes it 3.6 m wide makes it 4.8 m TALL, and one that makes
// it 2 cm thick makes it 1.5 cm wide. Same for the window backdrops, which must
// span 7 m of wall while staying ~2.4 m tall. Per-axis scaling is the only way to
// place these, and they are flat or boxy enough that the distortion doesn't read.
//
// Prefer the uniform modes everywhere else: these are Meshy-AI exports with no
// reliable metric basis, and stretching a chair or a plant on one axis is very
// visible.
//
// `anchorY`:
//  • 'floor'  (default) — base sits at y=0 (free-standing furniture).
//  • 'center' — vertically centered, so the caller's group `position[1]` places
//    it (used for wall-mounted items: TV, art, wall décor, window backdrop).
function Gltf({ url, fitWidth, fitHeight, fitSize, anchorY = 'floor', ...props }) {
  // args: (path, useDraco, useMeshopt, extendLoader) — we supply the decoder.
  const { scene } = useGLTF(url, false, false, withMeshopt);
  const obj = useMemo(() => {
    const s = scene.clone(true);
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(s).getSize(size);

    // No fit at all renders at native scale. <Model> supplies MODEL_CFG's real-world
    // size when the caller gives none, so this only happens for a key with no
    // MODEL_CFG entry at all.
    if (fitSize) {
      s.scale.set(fitSize[0] / (size.x || 1), fitSize[1] / (size.y || 1), fitSize[2] / (size.z || 1));
    } else {
      const k = fitHeight
        ? fitHeight / (size.y || 1)
        : fitWidth
          ? fitWidth / (Math.max(size.x, size.z) || 1)
          : 1;
      s.scale.setScalar(k);
    }

    // Re-measure AFTER scaling: the box below positions the model, so it has to
    // reflect the scaled geometry, not the native geometry.
    const box = new THREE.Box3().setFromObject(s);
    const c = new THREE.Vector3();
    box.getCenter(c);
    s.position.set(-c.x, anchorY === 'center' ? -c.y : -box.min.y, -c.z);
    return s;
  }, [scene, fitWidth, fitHeight, fitSize, anchorY]);
  // Wrap so caller props (position/rotation) don't overwrite the fit transform.
  return (
    <group {...props}>
      <primitive object={obj} />
    </group>
  );
}
// `fitSize` is destructured explicitly rather than riding through `...props`. It
// worked by accident before — Gltf happened to destructure it — but that made
// "which fit props does Model support?" unanswerable from its signature.
export function Model({ modelKey, fallback, fitWidth, fitHeight, fitSize, anchorY, ...props }) {
  const url = modelKey ? MODELS[modelKey] : null;
  if (!url) return fallback || null;
  // An explicit fit prop wins; otherwise fall back to the model's real-world size
  // from MODEL_CFG. Defaulting matters: a call site that simply forgot to pass a
  // size rendered at raw GLB scale with no warning — that is how Bathroom3D's tub
  // ended up an arbitrary size — and every caller wants the real size anyway.
  const fit =
    fitSize || fitHeight || fitWidth ? { fitSize, fitHeight, fitWidth } : fitPropsFor({ model: modelKey });
  return (
    <Suspense fallback={fallback || null}>
      <Gltf url={url} {...fit} anchorY={anchorY} {...props} />
    </Suspense>
  );
}
// The task-panel layer that used to live here — the pointer-gesture arbiter,
// FirstPersonView, SceneEnv and Task3DScene — was removed with the mini-game
// stations it served. What remains is the GLB loading layer: MODELS/Model for
// meshopt-decoded assets, and GLBoundary. Consumed by RoomFreeRoam (the room
// renderer) and RoomLayoutEditor.

// Falls back to `fallback` (the 2D task) if the 3D subtree throws.
export class GLBoundary extends Component {
  constructor(p) {
    super(p);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
