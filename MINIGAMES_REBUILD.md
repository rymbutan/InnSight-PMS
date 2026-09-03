> **SUPERSEDED — historical record.**
>
> The thirteen mini-game stations this document describes were **removed** in
> August 2026, when the panel asked for the 3D simulation to become "a
> procedural, analytical case study" rather than "a simple gamified bed-making
> task" (*Changes to be made in the System*, section 3). `CleaningGame`,
> `BedMaking3D`, `Bathroom3D`, `Minibar3D`, `Ac3D`, `Linen3D`, `Vacuum3D`,
> `Inspection3D`, `LostFoundGame`, `GuestRequestGame`, `extraTasks` and
> `mechanics` no longer exist in the codebase.
>
> What replaced them: `web/src/sim/inspection/` — the student is handed a
> booking and a room someone else already turned over, and must judge the room
> **against that booking**. See
> `docs/superpowers/specs/2026-08-18-3d-inspection-case-study-design.md`.
>
> The room itself was kept: `roomLayouts.js`, the `.glb` assets and the
> free-roam camera all survived and are what the inspection renders.
>
> Kept because the engineering decisions below (the gesture-arbiter fix, the
> non-uniform-shuffle bug, why the build is part of verification) still explain
> why the surviving code looks the way it does.

---

# Training activities — rebuild

All ten activities now share a mechanics kit, have a real fail condition, and use
physical interaction instead of buttons and number steppers. Build is clean; 25
grading unit tests pass.

---

## The bug behind "renders blank or broken"

Six imports had been silenced by prefixing the **import specifier** with an
underscore:

```js
import { GOOD, ISSUES, _shuffle, WhyProbe, ReferenceBinder, Coach } from './taskKit';
import { useEffect, _useMemo, useRef, useState } from 'react';
```

`taskKit` exports `shuffle`, not `_shuffle`. That's a hard ESM link error, so
**BedMaking3D threw on load every time** — and `GLBoundary` caught it and quietly
fell back to the 2D version, which is why it looked broken rather than crashed.
The same pattern had also broken `Toast.jsx`, `PublicBooking.jsx` and
`Reports.jsx`. All six removed; `vite build` now passes.

This is why the build is now part of verification — the whole class of bug is
invisible until something links the modules.

---

## What "more interactive" means now

**`sim/mechanics.jsx`** — grab, carry, release. `<Draggable>` → `<DropZone>`,
with the carried item following a raycast plane. Drops resolve by explicit AABB
test (`resolveDropZone`), **not** by raycasting collider meshes: raycast ordering
breaks down once zones overlap or sit behind transparent fixtures, and a release
that silently lands on the wrong invisible collider is exactly the "clicks don't
register" failure.

**`sim/taskScore.js`** — grading, deliberately React-free so the rules are
unit-testable. A task is graded on a **slip budget** and a **par time**, both
visible in a HUD while you work. Neither ends the run — you always finish the
shift, but the grade reflects how you got there.

Par is a target, not a cliff: being slower than par costs nothing, only the
generous outer limit (par × 2.5) does. A student who stops to read the SOP is not
punished for it.

---

## Per-activity

| Activity | Was | Now |
|---|---|---|
| **Linen & Towels** | ✱ steppers → pick-a-chip-then-click | Drag each linen off the cart onto its fixture. Par count derived from occupancy, never printed. Camera reframed — the bath mat was at the bottom edge of the frustum. |
| **Vacuuming** | 10 blind clicks, **hardcoded `GOOD`** | Press-and-hold the head and sweep. Scored on coverage %, redundant passes, and **direction** (far corner out toward the door). Its competency was previously unscoreable. |
| **Dining Set-Up** | shared button grid | Drag a 7-piece cover onto position-specific slots. Graded on position, not order. One distractor: a soiled glass from the previous cover. |
| **Turndown** | shared button grid | Five strictly-ordered steps: fold the coverlet, chocolate, slippers, curtain, dim the lamp. Out of order = slip naming the step actually due. |
| **Welcome Amenities** | shared button grid | Judgement, not memory — `ctx` decides what's correct. A VIP gets the fruit plate; a guest with a declared nut allergy must get **nothing** from the nut tray. |
| **Balcony** | shared button grid | Two phases: clear litter (some hidden behind furniture, one item is guest property → lost & found), then drag a cloth along the railing. Wiping before clearing = slip. |
| **Minibar** | select-then-click | Drag restocking, plus best-before dates — the cart is salted with expired units of types the room needs, so type-matching alone fails. |
| **Inspection** | nothing to compare against | Toggleable ghost overlay of the correct room + an SOP reference photo. False positives spend budget. |
| **Lost & Found** | grade was a 2-in-5 coin flip | Graded on **sweep order**, not luck. Items need a directional drag to reveal (pillow aside, drawer out). |
| **Guest Services** | 100% multiple choice | Press-and-hold to knock, then a mandatory 3s wait — entering early is a privacy slip. Amenities drag onto the cart. |
| **Bed-Making** | already good | Drag rig untouched. Gained par 80s / budget 2. |
| **Bathroom** | already good | 1.5s dwell gate untouched. Par is `16 + spots × 8` so the **mandatory dwell is a costed line item** — following the SOP can never make you late. |
| **A/C & Vents** | ± stepper buttons | Draggable thermostat dial (angle → temperature). One grille is randomly dusty; you must equip a cloth, and a vent only counts once actually clean. |

Four of these — Turndown, Amenities, Dining, Balcony — were previously **one
component with different label text**, 31% of Presidential's stations.

---

## Two blockers found in review

I had a fresh agent review the result adversarially, because most of it was
written by four agents working in parallel. It found two real blockers, both in
the same place:

**r3f v8 applies no movement threshold to `onClick`.** It fires on any
press-release where the object was hit at both ends. So panning the camera across
a fixture *counted as clicking it* — in Inspection3D, whose entire instruction is
"look around the room", glancing across three clean fixtures was 3 slips against a
budget of 2. An automatic fail for looking.

**A synthetic `stopPropagation()` cannot stop a native listener.** The camera's
drag-to-look is a native `pointerdown` on the same canvas element, so it fired
*during* every item drag — the camera yawed while the item moved, sliding the
world out from under the cursor. Items appeared to drift away from the pointer on
six stations.

Fixed with a gesture arbiter in `task3d.jsx`: a `claimed` flag so an interactive
element can lock out the camera, and a `moved` flag past a 5px slop radius so
click handlers can tell a look from a click. `RoomFreeRoam` had solved this years
ago; `task3d.jsx` never got the fix.

**Also fixed from that review:** repeat-press slip drains (one misunderstanding
could cost the whole budget — now `run.slipOnce(key, msg)` charges once per
cause), the HUD showing `budget + 1` pips while claiming `budget` spare,
`shuffle()` using an invalid comparator (`sort(() => 0.5 - Math.random())` is not
uniform, and it seeds randomisation in seven activities — now Fisher-Yates), a
stale-closure grading hazard in `Minibar3D`, Inspection charging a false positive
for re-clicking a defect you'd already correctly found, and the assessment
silently dropping `stars` / `elapsedSec` / `slips` / `usedReference` that every
activity was emitting.

---

## Known gaps

1. **`Vacuum3D.check()` can fire three slips at once** (direction + redundancy +
   leftover debris) against a budget of 2 — a guaranteed ISSUES. Direction is
   decided by the first cell painted and is unfixable by the time it's reported.
   Either report direction as coaching on the first stroke, or give this station
   budget 3.
2. **StrictMode purity** — `Inspection3D` and `Bathroom3D` mutate a ref inside a
   `setState` updater. A `doneRef` guard saves them today; `extraTasks.jsx` uses
   the correct `useEffect` pattern. Worth unifying.
3. **`DropZone` re-registers every render in `Minibar3D`** — `slotPos()` returns a
   fresh array, so zone registration churns. Harmless now, but every other
   consumer uses module constants for exactly this reason.
4. Three activities still route their result through the older
   `{ room, onComplete, onExit }` contract rather than `{ ctx, onResolve }` —
   they're launched from Housekeeping, not the station CATALOG.

None of these block use. The full audit of everything still outstanding —
the Vite dev server in production, seeded admin credentials, the ~6-user
rate-limit ceiling, the 3D room presentation — is in
`InnSight_Technical_Findings.md`.
