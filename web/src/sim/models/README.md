# Drop-in 3D models (.glb)

**The `.glb` files live in [`web/public/models/`](../../../public/models/), not here.**

This directory holds only documentation now. The binaries were moved out in
Phase 2 because Vite processes anything referenced from `src/` as a build asset: a
`new URL('./models/x.glb', import.meta.url)` reference makes `vite build` copy
every model into `dist/assets/` under a content-hashed name. With ~1 GB of models
that doubles the build, and it is exactly how 41 hashed `.glb` duplicates ended up
sitting in this folder. Files under `public/` are copied once, verbatim, and
served at their own URL.

## Adding a model

1. Drop the `.glb` into `web/public/models/`.
2. Register a fixture key in [`../task3d.jsx`](../task3d.jsx) → `MODELS`, using
   the `glb()` helper (it handles the base path and URL-encodes spaces):

   ```js
   export const MODELS = {
     vanity: glb('Bathroom Vanity Double'),
     tub:    glb('Grey Marble Bathtub'),
     // ...add a key per fixture you have a model for
   };
   ```

3. Give it a default size in [`../RoomFreeRoam.jsx`](../RoomFreeRoam.jsx) →
   `MODEL_CFG`.

A fixture whose key has a registered URL renders the `.glb` (via `<Model>`);
fixtures with no entry keep their procedural placeholder. No other code changes
are needed. Keep models low-poly and in meters (Y-up), origin at the floor.

Attribution and licensing for the bundled set:
[`../../../public/models/CREDITS.md`](../../../public/models/CREDITS.md).
