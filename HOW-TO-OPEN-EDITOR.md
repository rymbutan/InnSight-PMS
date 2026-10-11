# How to open the Room Layout Editor

> **Updated 2026-07-30.** This cheat-sheet has been rewritten twice; the original
> predated Phases 2–5 and had four instructions that no longer work. What changed:
>
> - **`/sim-demo` is gone.** The editor now lives on a real page in the app —
>   **Room Layouts (3D)**, in the hamburger menu — and it is **ADMIN-only**. Signing
>   in as housekeeping or front desk will neither show the menu entry nor let you reach
>   the URL. (`/sim-demo` still redirects, so old bookmarks survive, but the menu is
>   how you get there now.)
> - `docker compose up -d` **on its own is no longer enough** on a fresh machine —
>   every secret is now required, and seeding is a separate step.
> - Models live in **`web/public/models/`**, not `web/src/sim/models/`. Putting a
>   `.glb` back under `src/` is what once created ~1 GB of duplicate files.
> - Model sizes are registered in **`web/src/sim/modelSizes.js`**, and use `h`
>   (height) or `size`, **not** `w`.
>
> **8080 and 5180 both work** — they're the same gateway. `5173` is dead unless you
> start the Vite dev server yourself.

---

## TL;DR (stack already running, signed in as admin)

1. **☰** (top left) → **Room Layouts (3D)**
2. Click **"✏️ Edit layout"** on the tier you want — Standard, Deluxe, Suite or
   Presidential

No URL to remember. If you want one anyway it's `/room-layouts`.

---

## Cold start (fresh machine, or first time ever)

```bash
# 1. Start Docker Desktop — wait for the whale to stop animating ("Engine running")

# 2. Go to the project (quotes matter, the folder name has a space)
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"

# 3. Secrets — ONLY needed the first time, or if you have no .env yet.
#    Compose refuses to start without them. Safe to run: it won't overwrite
#    an existing .env.
bash scripts/gen-env.sh

# 4. Start everything (~30–60s)
docker compose up -d

# 5. Seed the database — ONLY needed once per fresh database.
#    Without this everything is "healthy" but nobody can log in.
bash scripts/db-seed.sh
```

Then:

6. Browser → **http://localhost:8080** → sign in as `admin`

   | | |
   |---|---|
   | Username | `admin` |
   | Password | *(ask whoever last reset it — not recorded here; this repo is public)* |

   - **On a brand-new database** (a fresh clone, or after
     `docker compose down -v`) it is instead the `ADMIN_INITIAL_PASSWORD` that
     step 3 printed, and you are **forced to change it** on first sign-in. Read
     it back with `grep ADMIN_INITIAL_PASSWORD .env`.
   - If neither works, somebody changed it. Do NOT keep guessing: five wrong
     attempts **permanently lock the account**, with no timer. Issue a fresh one
     with `bash scripts/unlock-admin.sh admin --reset-password`, which unlocks
     the account and prints a new password.
   - It must be `admin`, or another account holding **ADMIN**. The editor is not
     visible to any other role.
7. **☰** → **Room Layouts (3D)** → **"✏️ Edit layout"** on a tier

**Day-to-day** it's just `docker compose up -d` — steps 3 and 5 are one-time.

### Check it's up (optional)

```bash
docker compose ps
```

All 15 should say `Up`. Postgres/Redis/MinIO and the nine services show `healthy`;
the gateway has no healthcheck so it just says `Up`. Anything `Restarting` usually
means the database wasn't ready — wait and re-run `docker compose up -d`.

---

## Using the editor

| Action | How |
|---|---|
| Select | Click an item in the left list, or click it in the 3D room |
| Move / Rotate / Resize | Pick the mode along the top, drag the gizmo |
| Snap | The **SNAP** checkbox (top right of the toolbar) — 0.1 m / 15° |
| Add | **ADD ASSET** dropdown → **Add**, or **+ Wall** / **+ Station** |
| Exact values | **Inspector** (right) — position, rotation, scale, height, colour, Delete, Duplicate |
| Room itself | **ROOM** (bottom-left) — width / length / height / floor colour / spawn |
| Undo | **Undo (⌘Z)** |
| Save | Automatic, into this browser's localStorage |
| Discard everything | **Revert to file** |
| Export | **Copy block → clipboard** |
| Nudge | Arrow keys — 0.1 m per press |
| Delete selected | **Delete** / **Backspace** (or **Delete** in the Inspector) |
| Close | **✕**, top of the left panel next to "Layout editor · <tier>" |

**Esc does not close the editor** — use the **✕**. Nothing is lost either way; edits
autosave to localStorage as you make them.

All four tiers are editable from this page — **Standard**, **Deluxe**, **Suite** and
**Presidential**. (The old `/sim-demo` harness only offered three; Standard had to be
hand-edited in `roomLayouts.js`.)

**Give it a few seconds.** Presidential loads 23 compressed models and decodes ~2.9M
triangles, so furniture pops in progressively — grey boxes first, real models after.
That's expected, not a fault.

---

## ⚠️ Before you paste "Copy block" back into the code

`web/src/sim/roomLayouts.js` no longer stores hand-typed coordinates. Phase 3 made
placement **computed**:

```js
{ model: 'bed', pos: [0, atBack(l, FP.bed[1])], ry: RY.none, box: FP.bed },
```

`atBack(...)` puts a fixture's back face exactly on the wall using its **rendered**
footprint from the `FP` table. That's what fixed beds floating 29 cm off the wall and
a bathtub cutting into a wall.

The editor emits **literal numbers** (`pos: [0, -2.98]`). Pasting a whole block works,
but it throws that away — the next time a model's size changes, nothing re-derives.

So:

- **Small tweaks** → read the numbers out of the editor and hand-edit the relevant
  line in `roomLayouts.js`, keeping the helper form where you can.
- **Wholesale re-layout** → paste the block, then **always** run:

```bash
node scripts/check-room-layouts.mjs
```

This is not optional decoration. It checks reachability **and** 3D geometry: rendered
heights against the ceiling, fixtures clipping walls, collision boxes matching what
you can actually see, case goods flush to their wall, duplicate placements. It runs in
CI and in the pre-commit hook, so a broken layout fails the build.

Useful while positioning things:

```bash
node scripts/check-room-layouts.mjs --sizes    # rendered size + flush-at coords per fixture
node scripts/check-room-layouts.mjs --warn-only # report problems without failing
```

---

## Adding a new .glb model

```bash
# 1. Put the file in web/public/models/  — NOT web/src/sim/models/
#    Anything referenced from src/ gets a content-hashed COPY emitted into
#    dist/assets on every build. That's how ~1 GB of duplicates happened.
cp ~/Downloads/"My Asset.glb" web/public/models/

# 2. Compress it. Raw Meshy exports are 20–60 MB each.
bash scripts/optimize-models.sh        # meshopt + WebP, stages to .attic first

# 3. Measure it, so sizing is data and not a guess
node scripts/measure-models.mjs
```

Then register it in **`web/src/sim/modelSizes.js`** (two entries, same file):

```js
export const MODEL_FILES = {
  myasset: 'My Asset',          // filename WITHOUT .glb
};

export const MODEL_CFG = {
  myasset: { h: 0.75 },         // real-world HEIGHT in metres
};
```

**Use `h`, not `w`.** The old `{ w }` scaled uniformly off the horizontal footprint,
so height came out as whatever the asset's native aspect ratio happened to be — a
4.8 m tall rug, a 1 m tall king bed. Options:

| Use | When |
|---|---|
| `{ h: 0.75 }` | Almost always — height is what reads as wrong in a room |
| `{ w: 1.25 }` | Genuinely width-defined things (a TV, a towel bar) |
| `{ size: [x, y, z] }` | When no single scale can work — rugs (flat *and* wide), window backdrops |

Finally, if the validator needs to know about it:

```bash
# Refresh the native-dimension snapshot from the UNCOMPRESSED originals.
# The shipped models are meshopt-quantized, so their file-level sizes read as garbage.
node scripts/measure-models.mjs .attic/models-uncompressed-originals --save
node scripts/check-room-layouts.mjs
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Page won't load at all | Docker Desktop isn't running. Start it, then `docker compose up -d` |
| `required variable … is missing a value` | No `.env`. Run `bash scripts/gen-env.sh` |
| Everything healthy but login says **Invalid credentials** | Database never seeded. Run `bash scripts/db-seed.sh` |
| No **Room Layouts (3D)** in the **☰** menu | You're not signed in as an ADMIN. The page is role-gated; other roles don't see the entry |
| `/room-layouts` bounces you to the dashboard | Same cause — the route rejects non-ADMIN accounts, it doesn't just hide the link |
| `/room-layouts` bounces you to the login page | Not signed in at all — sign in at `/` first |
| An old `/sim-demo` bookmark | Still works; it redirects to `/room-layouts` |
| App shows **502** | A service is still starting. Re-run `docker compose up -d`, give it a minute |
| A service stuck `Restarting` | Usually the DB wasn't ready. Re-run `docker compose up -d` |
| **429 Too many requests** | The gateway rate limit. Wait a few seconds — not an outage |
| `localhost:5173` dead | That was a temporary dev server. Use 8080 (or 5180) |
| `localhost:3010` etc. dead | Deliberate — services no longer publish ports, so the gateway can't be bypassed. For debugging: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d` |
| Editor shows grey boxes | Models still decoding. Wait ~10–30s on Presidential |
| **Room is completely empty** — no floor, no grid, no furniture | Check the console. `WebAssembly.instantiate(): … Content Security Policy` means the gateway CSP lost `'wasm-unsafe-eval'`, so the meshopt decoder can't run and nothing decodes. See `services/gateway/nginx.conf` |
| Furniture loads but is **grey/untextured** | Console will show `Couldn't load texture blob:…` — the CSP's `connect-src` lost `blob:`. `img-src blob:` does *not* cover this; textures are fetched, not `<img>`-loaded |
| Changed `nginx.conf` but nothing changed | The config is baked into the gateway image. `docker compose build gateway && docker compose up -d gateway` — a plain `restart` reuses the old image |
| Room looks wrong after editing | Run `node scripts/check-room-layouts.mjs` — it will tell you exactly what and by how many cm |

---

## Related

- `README.md` — full project setup, architecture and security posture
- `PHASE_3_CHANGES.md` — why model sizing and layout placement work the way they do
- `web/src/sim/models/README.md` — the model drop-in rules, next to where they matter
