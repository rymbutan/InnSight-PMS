# Phase 4 — The mini-games

Closes G1, G3, G4, G5, G6, G7, G8, G9, G10, G11, G12. 220 unit tests pass (was 212).

**It also fixes a bug the audit didn't catch: every training run in the system was
scoring 0%.** See below — that one is worth reading first.

---

## ⚠️ Every training result scored 0% (not in the findings)

`services/auth/src/routes/training.routes.js` scored runs with:

```js
const SC = { GOOD: 1, ISSUES: 0.5 };   // UPPERCASE keys
const proc = SC[it.procedure] ?? 0;
```

The sim sends the constants from `web/src/sim/taskKit.jsx`, which are **lowercase**:

```js
export const GOOD = 'good'; export const ISSUES = 'issues'; export const SKIPPED = 'skipped';
```

So `SC['good']` was `undefined → 0` for every task of every run. **Every
`TrainingResult` row ever written had `scorePct: 0` and `tone: 'bad'`**, which made
the Training page's competency table — the entire point of the feature — meaningless.
`it.procedure !== 'SKIPPED'` never matched either, so skipped tasks counted as
attempted.

Normalised with `String(v).toLowerCase()`, accepting either case so an older client
can't silently zero itself again, and covered by **8 new unit tests** in
`training.scoring.test.js`. Verified live against the running stack:

| Payload | Before | After |
|---|---|---|
| 2× `good`/`good` | 0% | **100%** |
| `issues`/null + `issues`/`good` | 0% | **63%** |
| `good`/`good` + `skipped` | 0%, 2/2 attempted | **50%, 1/2 attempted** |

## Results are persisted, and shifts survive a reload (G4)

There were **zero API calls anywhere in `web/src/sim/`**. Only the cleaning
turnover persisted anything, via an inline `api.post` in `Housekeeping.jsx`; Guest
Services and Lost & Found raised a toast and threw the student's work away, so the
competency table could never reflect either.

New `web/src/sim/trainingLog.js` owns both halves:

- **`submitRun()`** — all three games now record a result. A failed save is
  *reported* ("the training result could not be saved…"), not swallowed; a student
  should know their score didn't reach their record.
- **`saveShift()` / `loadShift()` / `clearShift()`** — an in-progress shift is
  check-pointed after every station. Previously results lived in `useState` inside
  `RoomFreeRoam`, so a reload, a closed tab or an accidental "Leave shift" part-way
  through a 13-station Presidential suite discarded everything. Resuming shows a
  banner, and the Training page offers **Resume shift** / **Reset**.

  localStorage, not the server, and deliberately: a half-finished shift is UI
  state, and check-pointing to the DB on every station would write a row per click.
  Scoped per user + room, with a 12-hour expiry.

New `activity` column on `TrainingResult` (`TURNOVER` | `GUEST_SERVICE` |
`LOST_FOUND`) with migration `20260729000200_training_activity`, so the two
standalone activities are distinguishable from a room turnover. The competency
endpoint counts **only turnovers** toward room-tier mastery — folding a Guest
Services run into `tiers` would look like an unmastered room type and hold
`competent` at false forever. The activity value is whitelisted server-side.

## Vacuuming can now be failed (G3)

`Vacuum3D.jsx` was ten clickable dots and this line:

```js
onResolve({ procedure: GOOD, ... })   // hardcoded
```

`procedure` was **hardcoded to GOOD**, so the "Thoroughness" competency the station
exists to measure could not be scored. There was no way to fail.

Rebuilt as a held-drag coverage mechanic that grades three real SOP behaviours:

1. **Coverage** — every cell of a 13×11 grid must be passed over, so corners and
   edges can't be skipped. Below 90% the task won't finish.
2. **Direction** — dragging the nozzle door-ward *over carpet already cleaned* is
   the footprinting error; beyond a 25% budget it's a recorded slip.
3. **Overlap** — adjacent passes must overlap; a grid re-hit rate under 35% is a
   thin single pass.

The nozzle only paints while the pointer is **held**, which also kills the 2D
twin's hover-to-vacuum bug at the source.

## The four clone stations (G1)

```js
export const Turndown     = (p) => <ChecklistTask cfg={TURNDOWN} {...p} />;
export const AmenitySetup = (p) => <ChecklistTask cfg={AMENITY}  {...p} />;
export const Dining       = (p) => <ChecklistTask cfg={DINING}   {...p} />;
export const Balcony      = (p) => <ChecklistTask cfg={BALCONY}  {...p} />;
```

Four stations — 31% of a Presidential shift — that were the same component with
different label text, no scene at all, and `goodIds.every(id => done.includes(id))`
completion, i.e. **order-insensitive**, so "perform turndown in order" and "lay a
proper place setting" tested nothing about sequence or placement.

- **Dining is now a real drag-to-place cover.** You drag each item onto the table
  and it's judged on *where it lands* — fork left, knife right, glass upper right,
  napkin on the plate (and the plate has to be down first, so the napkin zone
  doesn't exist until it is). A misplacement names the correct position and the
  one you actually hit.
- **Turndown is sequence-checked.** Its SOP is a numbered procedure, so the steps
  must be performed in order; out-of-sequence clicks are refused and name the
  next step. Completed steps show their position rather than a tick.
- **Amenity and Balcony** get their own reactive SVG scenes (a vanity that fills in
  as you set each item; a balcony whose railing brightens when wiped, chairs square
  up, litter disappears when swept). They keep the select-the-right-actions
  mechanic **on purpose** — their SOPs genuinely are unordered sets, and forcing an
  order would invent a standard that doesn't exist. They are no longer clones, but
  they are not new mechanics either.

## The timer is scored, and ISSUES can be earned (G5, G6)

`elapsed` ticked and displayed in the old 2D hub but never reached `items`,
`computeVerdict` or the POST — and the 3D shift students actually play had **no
timer at all**.

`RoomFreeRoam` now has a shift clock that runs only while roaming (reading the SOP
binder inside a task doesn't burn it), displayed against a **par time** of 75s ×
station count, so it scales from a 7-station Standard to a 13-station Presidential.
Pace is an assessed row, which — together with vacuuming's new fail states — means
`ISSUES` is now reachable by doing the job badly, not only by skipping stations.

## Look and interaction stopped fighting (G9)

`el.requestPointerLock()` fired on **any** click while the station rings were
separately clickable, so clicking a ring also grabbed the pointer and swung the
camera. Once locked the OS pointer stops moving, so r3f kept raycasting from the
stale cursor position and ring clicks silently stopped working — which is why `E`
was the only dependable path despite the hint promising "drag or click to look".

Now: a press that moves less than 5px is an **interaction**, more is a **look**;
station rings ignore a click whose drag moved; and pointer lock is explicit
(**L**, Escape to release). The on-screen hint describes what actually works.

## ~490 lines of dead 2D fallback deleted (G10)

`CleaningGame.jsx`: **827 → 164 lines.** The station hub plus 2D Vacuuming,
Bathroom, Minibar, Thermostat, Linen, Inspection and BedMaking rendered only when
`supportsWebGL()` was false. On any normal browser it was dead, and it was harmful:

- it offered a **different, smaller curriculum** (7 hardcoded tasks instead of the
  tier's 7–13 stations), so no-WebGL users never saw turndown, amenity set-up,
  dining or balcony at all;
- it was where the hover-to-vacuum bug lived;
- two implementations of every task meant two sets of scoring rules, already drifted.

Replaced with a `WebGLRequired` notice that says what's wrong and how to fix it.

## Guest Services scoring bug and dead branch (G8)

- `if (o.ok) { out.current.door = GOOD; }` **erased** a recorded privacy violation
  the moment the student retried and got it right, so barging in scored identically
  to doing it correctly — and it made the ISSUES note below it unreachable dead
  text. Now `out.current.door || GOOD`, matching every other recorder in the file.
- `setPhase(o.ok ? 'objection' : 'objection')` — identical branches, an intended
  divergence never written. Now: you only face a price objection if you actually
  offered something, so declining to offer marks that competency **SKIPPED** rather
  than silently GOOD, and a pushy pitch draws a different guest reaction.

## Lost & Found is graded on skill, not luck (G7)

```js
procedure: found ? (searched.length <= 2 ? GOOD : ISSUES) : SKIPPED
```

The hiding place is uniformly random across 5 spots with no clues, so "Located the
item" was a **2-in-5 coin flip** — a perfect sweep could score ISSUES and a lucky
first click scored GOOD.

A room sweep is a *procedure*, so it's now graded on whether you followed the
circuit (bed linen → under the bed → case goods → soft seating → bathroom), which
is entirely within the student's control and independent of where the item is. The
circuit is recallable from a new SOP binder — grading against an order you cannot
know would just be a different lottery.

## Training page is no longer a dead end (G12)

It was a read-only table telling the student to "run the sim from the Housekeeping
screen" — on the page named Training, the one place a learner would look. It now
launches all four tier shifts and both standalone activities, shows station counts,
lists **what each activity assesses**, surfaces personal bests, and offers
Resume/Reset for check-pointed shifts. Practice rooms are fixtures (`T-101`…`T-115`)
so a practice run never changes a real room's housekeeping status.

## Bonus: G11 and a latent sizing trap

`Bathroom3D` asked for `modelKey="sink"`, which is **not a key in `MODELS`** (it's
`vanity`), so that sink was a procedural box forever even though
`Bathroom Vanity Double.glb` was right there. Its `tub` had no fit at all, so it
rendered at raw GLB scale. Unused `useMemo` import removed.

Fixing the tub properly meant fixing the cause: `<Model>` ignored `MODEL_CFG`, so
any call site that forgot to pass a size silently got raw scale. `<Model>` now
falls back to the model's real-world size, and destructures `fitSize` explicitly
(it previously worked only by accident, riding through `...props`).

---

## Verified

- **220/220 unit tests**, including 8 new ones pinning the scoring-case regression.
- **Against the live stack** (Docker up, seeded): scoring returns 100% / 63% / 50%
  where it used to return 0%; the `activity` migration applied via `migrate deploy`
  *and* re-applied idempotently by `db-init.sh`; the column and index exist; an
  unknown `activity` is whitelisted to `TURNOVER`.
- **Lost & Found, played through in the browser:** an out-of-order click is refused
  and names the correct next spot ("under the pillows comes next"); in-order clicks
  advance 1 → 2; the assessment recorded the deliberate slip with the exact spot and
  position ("searched out of order… sofa cushions on spot 4 of 5"); submitting
  persisted the run and it appeared in the results table.
- **Dining cover, driven with real PointerEvents:** fork into the knife slot is
  refused with "The fork goes to the LEFT of the plate — that's the knife
  position"; napkin before the plate is refused; correct drops fill their zone
  1/5 → 5/5; the napkin zone appears only once the plate is down; completion
  produced `procedure: "issues"` for the deliberate misplacements with
  `understanding: "good"`.
- **Turndown:** out-of-sequence refused and names the next step; a non-turndown
  action refused with its own reason; the evening-room scene renders and reacts.
- **Training page** renders the launcher, and the competency table shows the new
  "Other activities" column populated.
- `check-room-layouts.mjs` → ✅ ALL TIERS CLEAN; `check-shared.sh` in sync; build clean.

**Not verified:** a full 13-station Presidential shift played start to finish, the
new vacuuming mechanic under real mouse dragging (its logic was reviewed and the
build is clean, but I drove the cover task rather than the carpet), and the shift
autosave surviving an actual browser reload mid-shift.

Test-harness note: the browser automation's `left_click_drag` dispatches *mouse*
events, while `usePointerDrag` listens for *pointer* events — so the drag checks
above were driven with synthesised `PointerEvent`s. That is a limitation of the
tooling, not of the app; a real mouse or touch produces pointer events natively.

## Still open

- **The CI lint job still cannot pass (C1)** — unchanged from Phase 2. Prettier
  fails repo-wide and ESLint has no React/JSX plugin. Phase 5 step 38.
- **`Ac3D`, `Linen3D`, `Minibar3D`, `Inspection3D`** were already distinct mechanics
  and are untouched, but they still have no fail state of their own — the earned-
  ISSUES routes added here are vacuuming, pace, turndown sequence and cover
  placement.
- **Rows written before the `activity` migration default to `TURNOVER`.** Harmless
  in practice, because neither standalone game ever persisted anything before now,
  so no such rows exist outside a dev database.
- **Model load time** (Phase 3's open item) still applies: entering a Presidential
  suite decodes 2.9M triangles with fixtures popping in as they resolve.
- Phase 5 (security hardening) is untouched.
