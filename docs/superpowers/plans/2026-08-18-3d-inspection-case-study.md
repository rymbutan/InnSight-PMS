# 3D Inspection Case Study Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 7–13 station mini-game turnover shift with a procedural, analytical inspection case study: the student receives a booking (confirmation number, guest details, special requests), walks a pre-set-up 3D room, and flags what is wrong *for that booking*.

**Architecture:** A new `web/src/sim/inspection/` module holds four pure/data files (case generation, defect catalogue, scoring) and three React files (clipboard, flag menu, shift orchestrator). It renders through the existing `RoomShell` + `Player` from `RoomFreeRoam.jsx`, feeding them a **layout mutated by the injected defects** — so defects are expressed in the same `{model, pos, ry, box}` furniture data the room already uses. Scoring maps onto `Assessment.jsx`'s existing Did+Why rubric.

**Tech Stack:** React 18 + Vite, `@react-three/fiber` v8, `@react-three/drei`, Node's built-in `node:test` runner, Express/Prisma (one backend allow-list change).

**Spec:** `docs/superpowers/specs/2026-08-18-3d-inspection-case-study-design.md`

## Global Constraints

- **Deletion happens last** (Task 7), only after the replacement is working and verified. Never delete a module while something still imports it.
- **`RoomFreeRoam.jsx` must keep exporting `FixtureBody`, `itemY`, `MODEL_CFG`** — `RoomLayoutEditor.jsx` (the admin floor-plan tool on the Room Layouts page) imports them and is not part of this change.
- **`taskKit.jsx` and `taskScore.js` must survive the cut** — `Assessment.jsx` imports `GOOD`/`ISSUES`/`SKIPPED` and `fmtDuration` from them.
- `vite build` is the only thing that catches the broken-import class of bug that previously made a station silently fall back to 2D (see `MINIGAMES_REBUILD.md`). Run it after every task that touches imports.
- Pure logic (case generation, defect predicates, scoring) stays React-free so it is unit-testable with `node --test`.
- Frontend tests are ESM (`import`), backend tests are CJS (`require`) — match the file's own service.
- No new `.glb` assets. Props without a model (vacuum, mop bucket, rags, chemical bottles) are drawn with `RoundedBox`/primitives, as `Inspection3D` already does today.

---

### Task 1: Backend — allow `INSPECTION` as a training activity

**Files:**
- Modify: `services/auth/src/routes/training.routes.js` (`ACTIVITIES` ~line 8; the tier-vs-activity split in the summary ~line 116)
- Modify: `services/auth/src/prisma/schema.prisma` (comment on `TrainingResult.activity` ~line 60 — comment only, no column change)

**Interfaces:**
- Produces: `POST /api/training/results` accepts `activity: 'INSPECTION'` without coercion; the summary counts it toward room-tier mastery.

Without this the endpoint silently rewrites `INSPECTION` to `TURNOVER`, corrupting the instructor competency summary. No schema migration is needed — `activity` is a free `String` column.

- [ ] **Step 1: Add to the allow-list**

```js
const ACTIVITIES = ['TURNOVER', 'GUEST_SERVICE', 'LOST_FOUND', 'INSPECTION'];
```

- [ ] **Step 2: Count INSPECTION toward tier mastery**

The summary currently routes everything that is not `TURNOVER` into `activities`. `INSPECTION` is the room competency now and is performed against a room tier, so it belongs in `tiers` — otherwise `competent` (every tier ≥85) becomes unreachable for a student who only does the new activity. Replace the branch:

```js
      // Room-tier mastery counts the room-based activities: the legacy TURNOVER
      // shift and the INSPECTION case study that replaced it. Both are performed
      // against a room tier and both are scored 0-100, so the best score per tier
      // is meaningful across the transition. Guest Services / Lost & Found are not
      // tier-based and would make a tier look unmastered forever.
      if ((r.activity || 'TURNOVER') === 'TURNOVER' || r.activity === 'INSPECTION') {
```

- [ ] **Step 3: Update the schema comment**

```prisma
  activity       String   @default("TURNOVER") // TURNOVER | GUEST_SERVICE | LOST_FOUND | INSPECTION
```

- [ ] **Step 4: Verify**

Run: `cd services/auth && node --test 'src/**/*.test.js'`
Expected: all pass.

Then confirm the coercion is gone by posting an `INSPECTION` result with a staff token and reading it back — `activity` must come back as `INSPECTION`, not `TURNOVER`.

---

### Task 2: Case file generation

**Files:**
- Create: `web/src/sim/inspection/caseFile.js`
- Create: `web/src/sim/inspection/caseFile.test.js`

**Interfaces:**
- Produces:
  - `DEFECT_IDS: string[]` — the six ids.
  - `makeCaseFile({ roomTier, pax?, rng?, reservation? }): CaseFile` where
    `CaseFile = { confirmationNumber, guestName, adults, children, pax, roomTier, nights, arrival, specialRequests, injected: string[] }`.
  - When `reservation` is supplied (Housekeeping path) its `guestName`, `adults`, `children`, `specialRequests`, `confirmationNumber` are used verbatim; defects are still injected synthetically.
- Consumed by: Tasks 3, 5, 6.

- [ ] **Step 1: Write the failing test**

Create `web/src/sim/inspection/caseFile.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';

import { makeCaseFile, DEFECT_IDS } from './caseFile.js';
import { DEFECTS } from './defects.js';

// Deterministic rng so a generated case can be asserted exactly.
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

test('injects between 2 and 4 defects', () => {
  for (let i = 1; i < 40; i += 1) {
    const c = makeCaseFile({ roomTier: 'Standard', rng: seeded(i) });
    assert.ok(c.injected.length >= 2 && c.injected.length <= 4, `got ${c.injected.length}`);
  }
});

test('every injected defect is applicable to the case it was injected into', () => {
  for (let i = 1; i < 40; i += 1) {
    const c = makeCaseFile({ roomTier: 'Suite', rng: seeded(i) });
    for (const id of c.injected) {
      const def = DEFECTS.find((d) => d.id === id);
      assert.ok(def, `unknown defect ${id}`);
      assert.ok(def.appliesTo(c), `${id} injected but does not apply to pax=${c.pax}`);
    }
  }
});

test('every injected id is a known defect id', () => {
  const c = makeCaseFile({ roomTier: 'Standard', rng: seeded(7) });
  for (const id of c.injected) assert.ok(DEFECT_IDS.includes(id));
});

test('party composition is internally consistent', () => {
  const c = makeCaseFile({ roomTier: 'Deluxe', rng: seeded(3) });
  assert.equal(c.pax, c.adults + c.children);
  assert.ok(c.adults >= 1);
});

test('a supplied reservation overrides the synthetic booking but defects still inject', () => {
  const c = makeCaseFile({
    roomTier: 'Standard',
    rng: seeded(5),
    reservation: {
      confirmationNumber: 'R-REAL123',
      guestName: 'Dela Cruz, Maria',
      adults: 2,
      children: 2,
      specialRequests: 'Late arrival, around 11pm.',
    },
  });
  assert.equal(c.confirmationNumber, 'R-REAL123');
  assert.equal(c.guestName, 'Dela Cruz, Maria');
  assert.equal(c.pax, 4);
  assert.equal(c.specialRequests, 'Late arrival, around 11pm.');
  assert.ok(c.injected.length >= 2);
});

test('two runs with different seeds differ', () => {
  const a = makeCaseFile({ roomTier: 'Standard', rng: seeded(1) });
  const b = makeCaseFile({ roomTier: 'Standard', rng: seeded(999) });
  assert.notDeepEqual(
    { i: a.injected, p: a.pax, g: a.guestName },
    { i: b.injected, p: b.pax, g: b.guestName }
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && node --test src/sim/inspection/caseFile.test.js`
Expected: FAIL — modules not found. (Task 3 supplies `defects.js`; write both before this test passes.)

- [ ] **Step 3: Implement `caseFile.js`**

Requirements the implementation must satisfy:
- `DEFECT_IDS` exported as the six ids in a stable order.
- Booking generated from small name/request pools; `nights` 1–4; `arrival` an ISO date string.
- `pax = adults + children`, `adults >= 1`.
- **Coherence:** build the booking first, then filter `DEFECTS` by `appliesTo(caseFile)` and choose 2–4 from the survivors. Never inject a defect the case cannot support.
- If fewer than 2 defects apply, widen the booking (e.g. bump `pax`) and retry rather than emitting a 1-defect case.
- Accepts an injectable `rng` (default `Math.random`) so tests are deterministic. Use Fisher–Yates for shuffling — `sort(() => 0.5 - rng())` is not uniform and is a bug this codebase has already been bitten by (`MINIGAMES_REBUILD.md`).
- `reservation` fields, when present and non-null, override the synthetic ones.

- [ ] **Step 4: Run to verify it passes** (after Task 3 lands `defects.js`)

Run: `cd web && node --test src/sim/inspection/caseFile.test.js`
Expected: PASS.

---

### Task 3: Defect catalogue

**Files:**
- Create: `web/src/sim/inspection/defects.js`
- Create: `web/src/sim/inspection/defects.test.js`

**Interfaces:**
- Produces:
  - `DEFECTS: Defect[]` where `Defect = { id, category, title, appliesTo(caseFile), why, feedback, anchor, apply(layout, caseFile) }`.
  - `CATEGORY_OPTIONS: {id,label}[]` — what the flag menu offers.
  - `applyDefects(layout, caseFile): { layout, anchors }` — returns the mutated furniture layout plus the clickable anchors `[{ id, defectId|null, label, pos, size }]`. Anchors include **clean decoys** so flagging is a real judgment, not "click the only highlighted thing".
- Consumed by: Tasks 2, 4, 5.

The six ids: `room_mismatch`, `amenity_math`, `blocked_path`, `lingering_equipment`, `lived_in`, `incomplete_stock`.

- [ ] **Step 1: Write the failing test**

Create `web/src/sim/inspection/defects.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';

import { DEFECTS, CATEGORY_OPTIONS, applyDefects } from './defects.js';

const baseCase = (over = {}) => ({
  confirmationNumber: 'R-TEST',
  guestName: 'Test Guest',
  adults: 2,
  children: 0,
  pax: 2,
  roomTier: 'Standard',
  nights: 2,
  arrival: '2027-01-01',
  specialRequests: null,
  injected: [],
  ...over,
});

const layout = () => ({
  w: 6,
  l: 8,
  furniture: [
    { model: 'bed', pos: [0, -2], ry: 0 },
    { model: 'sofa', pos: [-2, 1], ry: 0 },
    { model: 'towelstack', pos: [2, 3], ry: 0 },
    { model: 'minibar', pos: [2, -1], ry: 0 },
  ],
});

test('there are exactly six defect categories, matching the change request', () => {
  assert.equal(DEFECTS.length, 6);
  assert.deepEqual(
    DEFECTS.map((d) => d.id).sort(),
    ['amenity_math', 'blocked_path', 'incomplete_stock', 'lingering_equipment', 'lived_in', 'room_mismatch']
  );
});

test('every defect carries the fields the UI and rubric need', () => {
  for (const d of DEFECTS) {
    assert.ok(d.title && typeof d.title === 'string', `${d.id} title`);
    assert.ok(d.why && typeof d.why === 'string', `${d.id} why`);
    assert.ok(d.feedback && typeof d.feedback === 'string', `${d.id} feedback`);
    assert.equal(typeof d.appliesTo, 'function', `${d.id} appliesTo`);
    assert.equal(typeof d.apply, 'function', `${d.id} apply`);
  }
});

test('the flag menu offers every defect category', () => {
  for (const d of DEFECTS) {
    assert.ok(CATEGORY_OPTIONS.some((o) => o.id === d.id), `${d.id} missing from menu`);
  }
});

test('amenity math error needs a party big enough to be short-changed', () => {
  const d = DEFECTS.find((x) => x.id === 'amenity_math');
  assert.equal(d.appliesTo(baseCase({ adults: 1, children: 0, pax: 1 })), false);
  assert.equal(d.appliesTo(baseCase({ adults: 2, children: 2, pax: 4 })), true);
});

test('room mismatch needs a couple — the bed setup is only wrong relative to the booking', () => {
  const d = DEFECTS.find((x) => x.id === 'room_mismatch');
  assert.equal(d.appliesTo(baseCase({ adults: 2, children: 0, pax: 2 })), true);
  assert.equal(d.appliesTo(baseCase({ adults: 1, children: 0, pax: 1 })), false);
});

test('applying a defect mutates the layout and never mutates the input', () => {
  const original = layout();
  const snapshot = JSON.stringify(original);
  const c = baseCase({ injected: ['room_mismatch'] });
  const out = applyDefects(original, c);
  assert.equal(JSON.stringify(original), snapshot, 'input layout was mutated');
  assert.notEqual(JSON.stringify(out.layout.furniture), JSON.stringify(original.furniture));
});

test('room mismatch replaces the single bed with two twins', () => {
  const c = baseCase({ injected: ['room_mismatch'] });
  const out = applyDefects(layout(), c);
  const beds = out.layout.furniture.filter((f) => f.model === 'twin');
  assert.equal(beds.length, 2);
  assert.equal(out.layout.furniture.some((f) => f.model === 'bed'), false);
});

test('anchors cover every injected defect and also include clean decoys', () => {
  const c = baseCase({ injected: ['room_mismatch', 'incomplete_stock'] });
  const { anchors } = applyDefects(layout(), c);
  for (const id of c.injected) {
    assert.ok(anchors.some((a) => a.defectId === id), `no anchor for ${id}`);
  }
  assert.ok(anchors.some((a) => a.defectId === null), 'no clean decoy anchors');
});

test('an anchor is never labelled with the answer', () => {
  const c = baseCase({ injected: ['lingering_equipment'] });
  const { anchors } = applyDefects(layout(), c);
  for (const a of anchors) {
    assert.ok(!/wrong|defect|issue|error/i.test(a.label), `anchor label gives it away: ${a.label}`);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && node --test src/sim/inspection/defects.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `defects.js`**

Per-defect behaviour:

| id | `appliesTo` | `apply` mutation | anchor |
|---|---|---|---|
| `room_mismatch` | `pax === 2 && children === 0` (a couple) | remove the `bed`, add two `twin` beds side by side | the beds |
| `amenity_math` | `pax >= 3` | reduce `towel`/`towelstack` entries to fewer than `pax` | towel rack / vanity |
| `blocked_path` | always | move `sofa` (or add a luggage-rack primitive) into the bathroom walkway | the blocking item |
| `lingering_equipment` | always | add vacuum + mop-bucket primitives mid-room, chemicals by the vanity | the equipment |
| `lived_in` | always | rumpled-duvet primitive on the bed + skew the `curtain` rotation | bed / curtains |
| `incomplete_stock` | always | strip minibar stock props, omit the price-list card | the minibar |

Rules the implementation must follow:
- `apply` is **pure** — deep-copy the furniture array; never mutate the caller's layout (the test asserts this).
- Primitive-drawn props are emitted as furniture entries with a `prim` field (e.g. `{ prim: 'vacuum', pos, size }`) that Task 5's renderer draws; they are not `.glb` models and must not be passed to the model loader.
- `applyDefects` returns 3–5 **clean decoy** anchors (wardrobe, desk, TV, artwork) alongside the defect anchors, so hovering does not reveal the answer.
- Anchor `label` names the object only ("Bed", "Minibar"), never its state.

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && node --test src/sim/inspection/defects.test.js && node --test src/sim/inspection/caseFile.test.js`
Expected: both PASS.

---

### Task 4: Scoring

**Files:**
- Create: `web/src/sim/inspection/inspectionScore.js`
- Create: `web/src/sim/inspection/inspectionScore.test.js`

**Interfaces:**
- Consumes: `GOOD`, `ISSUES`, `SKIPPED` from `../taskKit`.
- Produces: `scoreInspection({ caseFile, flags, elapsedSec }): items[]` shaped for `Assessment.jsx` — `{ key, label, procedure, understanding, note, feedback }`. `flags` is `[{ anchorId, defectId|null, chosenCategory }]` — `defectId` is what the anchor actually was, `chosenCategory` what the student picked.
- Consumed by: Task 5.

- [ ] **Step 1: Write the failing test**

Create `web/src/sim/inspection/inspectionScore.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';

import { GOOD, ISSUES } from '../taskKit.jsx';
import { scoreInspection } from './inspectionScore.js';

const c = { injected: ['room_mismatch', 'amenity_math'], roomTier: 'Standard', pax: 4 };
const itemFor = (items, key) => items.find((i) => i.key === key);

test('a correctly found and correctly categorised defect scores both halves', () => {
  const items = scoreInspection({
    caseFile: c,
    flags: [{ anchorId: 'a1', defectId: 'room_mismatch', chosenCategory: 'room_mismatch' }],
    elapsedSec: 60,
  });
  const it = itemFor(items, 'room_mismatch');
  assert.equal(it.procedure, GOOD);
  assert.equal(it.understanding, GOOD);
});

test('found but miscategorised scores the Did, fails the Why, and returns feedback', () => {
  const items = scoreInspection({
    caseFile: c,
    flags: [{ anchorId: 'a1', defectId: 'room_mismatch', chosenCategory: 'lived_in' }],
    elapsedSec: 60,
  });
  const it = itemFor(items, 'room_mismatch');
  assert.equal(it.procedure, GOOD);
  assert.equal(it.understanding, ISSUES);
  assert.ok(it.feedback && it.feedback.length > 0);
});

test('a missed defect fails the Did and has no Why to judge', () => {
  const items = scoreInspection({ caseFile: c, flags: [], elapsedSec: 60 });
  assert.equal(itemFor(items, 'amenity_math').procedure, ISSUES);
  assert.equal(itemFor(items, 'amenity_math').understanding, null);
});

test('there is one item per injected defect, plus a precision item', () => {
  const items = scoreInspection({ caseFile: c, flags: [], elapsedSec: 60 });
  assert.equal(items.length, c.injected.length + 1);
  assert.ok(itemFor(items, 'precision'));
});

test('a clean room flagged as faulty is a false positive and costs precision', () => {
  const clean = scoreInspection({ caseFile: c, flags: [], elapsedSec: 60 });
  assert.equal(itemFor(clean, 'precision').procedure, GOOD);

  const sloppy = scoreInspection({
    caseFile: c,
    flags: [{ anchorId: 'x', defectId: null, chosenCategory: 'lived_in' }],
    elapsedSec: 60,
  });
  assert.equal(itemFor(sloppy, 'precision').procedure, ISSUES);
});

test('marking a clean object as correct is not a false positive', () => {
  const items = scoreInspection({
    caseFile: c,
    flags: [{ anchorId: 'x', defectId: null, chosenCategory: 'ok' }],
    elapsedSec: 60,
  });
  assert.equal(itemFor(items, 'precision').procedure, GOOD);
});

test('flagging everything does not pass — the degenerate strategy must fail', () => {
  // Both real defects found, but six clean objects condemned too.
  const flags = [
    { anchorId: 'a1', defectId: 'room_mismatch', chosenCategory: 'room_mismatch' },
    { anchorId: 'a2', defectId: 'amenity_math', chosenCategory: 'amenity_math' },
    ...Array.from({ length: 6 }, (_, i) => ({
      anchorId: `c${i}`,
      defectId: null,
      chosenCategory: 'lived_in',
    })),
  ];
  const items = scoreInspection({ caseFile: c, flags, elapsedSec: 60 });
  assert.notEqual(itemFor(items, 'precision').procedure, GOOD);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && node --test src/sim/inspection/inspectionScore.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `inspectionScore.js`**

- One item per `caseFile.injected` id, keyed by that id, labelled with the defect title.
- Precision item keyed `precision`: `GOOD` at 0 false positives, `ISSUES` at 1–2, `SKIPPED` at 3+.
- `chosenCategory === 'ok'` on a clean anchor is correct behaviour, not a false positive.
- Marking a *defective* anchor "ok" counts as a miss, not a false positive.
- `note` carries the defect's `why`; `feedback` is set only when `understanding` is `ISSUES`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && node --test src/sim/inspection/inspectionScore.test.js`
Expected: PASS (7 tests).

---

### Task 5: The inspection shift UI

**Files:**
- Modify: `web/src/sim/RoomFreeRoam.jsx` (export `Player` — add `export` to `function Player`, ~line 578)
- Create: `web/src/sim/inspection/Clipboard.jsx`
- Create: `web/src/sim/inspection/FlagMenu.jsx`
- Create: `web/src/sim/inspection/InspectionShift.jsx`

**Interfaces:**
- Consumes: `RoomShell`, `Player`, `itemY`, `FixtureBody` from `../RoomFreeRoam`; `getRoomPlan` from `../roomLayouts`; `applyDefects`, `CATEGORY_OPTIONS` from `./defects`; `makeCaseFile` from `./caseFile`; `scoreInspection` from `./inspectionScore`; `Assessment` from `../Assessment`.
- Produces: `<InspectionShift room reservation onComplete onExit />` — `onComplete(items)` receives the Assessment items so the caller can log the run.

- [ ] **Step 1: Export `Player` from RoomFreeRoam**

Change `function Player({ ... })` to `export function Player({ ... })`. Nothing else in that file changes in this task.

- [ ] **Step 2: Build `Clipboard.jsx`**

A panel showing the case file: confirmation number, guest name, adults/children (and total pax), nights, arrival, and special requests — with "None on file" when there are none. Opens automatically when the shift starts and toggles from a HUD button and the `C` key. It must remain reachable at all times; the student is meant to re-read it.

- [ ] **Step 3: Build `FlagMenu.jsx`**

Given the clicked anchor, presents "This is correct — no issue" plus the six categories from `CATEGORY_OPTIONS`, and calls back with the chosen id (`'ok'` or a defect id). Escape closes without recording. An anchor already resolved is not re-openable.

- [ ] **Step 4: Build `InspectionShift.jsx`**

- Derives the case: `makeCaseFile({ roomTier, reservation })`.
- Derives the room: `applyDefects(getRoomPlan(tier), caseFile)` → `{ layout, anchors }`.
- Renders `<Canvas>` with `<RoomShell layout={layout} />`, `<Player layout={layout} …/>`, and an `<Anchors>` layer drawing each anchor as an invisible-but-hoverable hitbox with a hover outline.
- Draws primitive props (`prim` entries in the furniture list) with `RoundedBox` — vacuum, mop bucket, rags, chemical bottles, rumpled duvet.
- Reuses `RoomFreeRoam`'s pointer arbitration convention: a `dragRef` with a 5px slop radius so a look-drag never counts as a click. **This is not optional** — r3f v8 fires `onClick` on any press-release pair, and the identical bug once made "look around the room" register three false clicks (`MINIGAMES_REBUILD.md`).
- Tracks `flags[]`, elapsed seconds, and a `resolved` set.
- "Finish inspection" → `scoreInspection(...)` → `<Assessment items=… />` → `onComplete(items)`.

- [ ] **Step 5: Verify the build**

Run: `cd web && npm run build`
Expected: succeeds. A broken import here is exactly the failure mode that silently degraded a station in the past, so treat any warning about an unresolved import as a hard failure.

---

### Task 6: Wire the two entry points

**Files:**
- Modify: `web/src/pages/Training.jsx` (lazy import ~line 9; launch ~line 355; tier blurbs ~line 36)
- Modify: `web/src/pages/Housekeeping.jsx` (lazy import ~line 11; launch ~line 471)
- Modify: `web/src/sim/trainingLog.js` (`ACTIVITY` ~line 22)

**Interfaces:**
- Consumes: `InspectionShift` (Task 5); `ACTIVITY.INSPECTION`; `GET /api/reservations?assignedRoomId=…` for the Housekeeping path.

- [ ] **Step 1: Add the activity constant**

In `web/src/sim/trainingLog.js`:

```js
export const ACTIVITY = {
  TURNOVER: 'TURNOVER',
  GUEST_SERVICE: 'GUEST_SERVICE',
  LOST_FOUND: 'LOST_FOUND',
  INSPECTION: 'INSPECTION',
};
```

- [ ] **Step 2: Training page — synthetic cases**

Swap the `CleaningGame` lazy import for `InspectionShift` and render it with the practice room and **no** reservation, so `makeCaseFile` generates the booking. Update the page copy and the `TIERS` blurbs: they currently advertise station counts ("Bed, bathroom, minibar, linens, A/C, carpet, final inspection") which no longer exist. Describe the inspection case study instead. Log with `ACTIVITY.INSPECTION`.

- [ ] **Step 3: Housekeeping page — real reservation**

Fetch the room's current reservation before launching and pass it through:

```js
const { data } = await api.get(`/api/reservations?assignedRoomId=${room.id}`);
const reservation = Array.isArray(data) ? data[0] : null;
```

Best-effort: a failed lookup or a vacant room falls back to `reservation: null` (synthetic booking) rather than blocking the inspection. Keep the existing side effect — completing sets the room to Vacant Clean — and log with `ACTIVITY.INSPECTION`.

- [ ] **Step 4: Verify the build and both flows**

Run: `cd web && npm run build`, then rebuild the web image and exercise both pages: Training launches a synthetic case; Housekeeping on a room with a booking shows that guest's real name and special requests on the clipboard.

---

### Task 7: Remove the mini-games

**Files:**
- Delete: `web/src/sim/CleaningGame.jsx`, `BedMaking3D.jsx`, `Bathroom3D.jsx`, `Minibar3D.jsx`, `Ac3D.jsx`, `Linen3D.jsx`, `Vacuum3D.jsx`, `Inspection3D.jsx`, `LostFoundGame.jsx`, `GuestRequestGame.jsx`, `extraTasks.jsx`, `mechanics.jsx`, `task3d.jsx`
- Delete: `web/src/pages/SimTest.jsx`
- Modify: `web/src/App.jsx` (remove the `SimTest` import ~line 27 and its route ~line 209)
- Modify: `web/src/sim/RoomFreeRoam.jsx` (remove the default-export shift orchestrator and `Stations`; keep `RoomShell`, `Player`, `FixtureBody`, `itemY`, `MODEL_CFG`)
- Possibly modify: `web/src/pages/Housekeeping.jsx` if it launches `LostFoundGame`/`GuestRequestGame`

**Do this task last**, and only once Tasks 5–6 are verified working.

**Must survive:** `taskKit.jsx` and `taskScore.js` (`Assessment.jsx` imports `GOOD`/`ISSUES`/`SKIPPED` and `fmtDuration`), `roomLayouts.js`, `modelSizes.js`, `Assessment.jsx`, `RoomLayoutEditor.jsx`, and `RoomFreeRoam.jsx`'s rendering exports.

- [ ] **Step 1: Find every remaining consumer before deleting anything**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/web"
for m in CleaningGame BedMaking3D Bathroom3D Minibar3D Ac3D Linen3D Vacuum3D Inspection3D LostFoundGame GuestRequestGame extraTasks mechanics task3d SimTest; do
  echo "── $m"
  grep -rn "$m" src --include="*.jsx" --include="*.js" | grep -v "^src/sim/$m.jsx" | grep -v "^src/pages/$m.jsx"
done
```

Every hit outside the module's own file must be resolved — rewired or deleted — before that module goes.

- [ ] **Step 2: Handle the Housekeeping side activities**

`Housekeeping.jsx` may launch `LostFoundGame` / `GuestRequestGame` for non-cleaning task types. The change request removes the mini-games, so remove those launches and the branches that reach them. If a task type is left with nothing to launch, remove that task type from the UI rather than leaving a dead button.

- [ ] **Step 3: Delete the modules and unroute SimTest**

Remove the files, then delete the `SimTest` import and `<Route>` from `App.jsx`.

- [ ] **Step 4: Strip the shift orchestrator from RoomFreeRoam**

Remove its default export and the `Stations` component. Update the file's header comment to say it is now the room-rendering library shared by the inspection shift and the layout editor.

- [ ] **Step 5: Prove nothing dangles**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/web" && npm run build
```

Expected: a clean build. Then re-run Step 1's grep — it must return nothing outside deleted files.

- [ ] **Step 6: Re-run every frontend test and the whole suite**

```bash
cd web && node --test 'src/**/*.test.js'
```

Expected: all pass. `taskScore.test.js` must still pass if `taskScore.js` was kept; if the cut removed everything it tested, delete the test with the code rather than leaving it asserting nothing.

- [ ] **Step 7: Rebuild and smoke-test the running app**

Rebuild the `web` image, then confirm: Training launches the inspection case study, Housekeeping launches it for a real room, the Room Layouts admin editor still renders furniture (it depends on `FixtureBody`/`itemY`), and no route 404s.
