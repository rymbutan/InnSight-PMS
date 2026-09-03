# Inspection Scenario Authoring — Design Spec

Follow-on to `2026-08-18-3d-inspection-case-study-design.md`. That work replaced
the mini-games with an inspection case study whose faults are generated
procedurally from hardcoded rules in `sim/inspection/defects.js`. An instructor
cannot change what is wrong in the room, only what the room itself contains
(via the existing Room Layouts editor).

This adds authoring: an instructor places things wrongly, tags each wrong thing
with the category it belongs to, sets the booking, and saves it as a named
scenario students then inspect.

## The idea

Rather than exposing "defect rules" as abstract parameters, the instructor
**edits the room into its wrong state directly**. Drag the sofa across the
bathroom door. Drop a vacuum mid-floor. Delete two towels. Then tag each of
those objects with one of the six categories. What you see in the editor is
exactly what the student walks into.

That framing keeps the integration small, because the inspection already
consumes exactly three things: a case file, a layout, and tagged anchors.

| Path | Produces `{ layout, anchors }` |
|---|---|
| Procedural (existing) | `applyDefects(getRoomPlan(tier), caseFile)` |
| Authored (new) | `fromScenario(scenario)` |

Same shape either way, so `InspectionShift` changes only in where it sources
those values, and `inspectionScore.js` is untouched.

## Data model

Scenarios live in the **auth** service, which already owns the training domain
(`/api/training/results`, `/api/training/competency`, `TrainingResult`).

```prisma
model InspectionScenario {
  id         String   @id @default(uuid())
  name       String
  roomTier   String   // Standard | Deluxe | Suite | Presidential
  active     Boolean  @default(true)
  booking    Json     // { guestName, adults, children, specialRequests }
  furniture  Json     // the authored (faulted) furniture array
  anchors    Json     // [{ id, label, defectId|null, pos:[x,z], size:[w,h,d], y? }]
  createdBy  String?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@index([roomTier, active])
}
```

**Why store the whole furniture array rather than a delta against the tier
layout.** A delta would stay in sync if someone later edits the base room in
the layout editor — but it would also silently *change what the student is
graded on*, which is worse: an authored scenario is a teaching artefact and
must render the same way every time. A full snapshot is a few dozen small
objects, and it makes a scenario self-contained and reproducible. The cost is
that a scenario does not inherit later base-layout edits; re-author it if the
room itself changes.

`confirmationNumber` is deliberately **not** stored. It is generated per run so
two students inspecting the same scenario do not see the same booking
reference, which would make the exercise look like a shared worksheet rather
than their own arriving guest.

## API

All under the existing `/api` mount in the auth service.

| Route | Guard | Purpose |
|---|---|---|
| `GET /api/training/scenarios?roomTier=&active=` | any staff | the sim pulls authored scenarios |
| `POST /api/training/scenarios` | ADMIN/MANAGER | create |
| `PATCH /api/training/scenarios/:id` | ADMIN/MANAGER | rename, re-author, activate/deactivate |
| `DELETE /api/training/scenarios/:id` | ADMIN/MANAGER | remove |

Reads are open to all staff because the student's sim must fetch them; writes
are management-only, matching how property configuration is guarded elsewhere
(`ROOM_ADMIN` on facilities/room types). Every route carries `requireRole(...)`
or the service's own `authz.test.js` fails the build.

Validation on write: `name` non-empty, `roomTier` one of the four tiers,
`furniture`/`anchors` arrays, `booking.adults >= 1`, `children >= 0`. A stored
anchor's `defectId` must be one of the six known ids or `null` — an unknown id
would produce an ungradeable fault that can never be matched by the flag menu.

## Selection at run time

`InspectionShift` asks for a case for a tier:

1. Fetch active scenarios for that tier (best-effort — a failed request falls
   back to procedural rather than blocking the inspection).
2. If any exist, pick one at random; build the case from its booking, its
   furniture and its anchors, generating a fresh confirmation number.
3. If none exist, generate procedurally exactly as today.

Authored scenarios **join** the pool rather than replacing generation, so
repeat plays still vary and a tier with no authored content keeps working.

`caseFile.injected` is derived from the authored anchors (the distinct
`defectId`s present), which is what scoring iterates — so an authored scenario
grades through the identical path as a generated one.

## Editor

A new admin page, **Inspection Scenarios (3D)**, in the menu beside Room
Layouts, ADMIN-only like its neighbour.

- Pick a tier → loads that tier's base layout as the starting point.
- Select any object; move/rotate it with the same `TransformControls` gizmo the
  layout editor uses. Delete it. Duplicate it.
- Add props from a palette: any `.glb` model key, plus the primitive props the
  inspection already draws (vacuum, mop bucket, chemicals, rumpled bedding,
  luggage rack).
- Tag the selected object: **clean**, or one of the six categories. Tagged
  objects become the student's clickable anchors; clean-tagged objects become
  decoys.
- Edit the booking: guest name, adults, children, special requests.
- Save / rename / duplicate / activate / delete scenarios for that tier.
- **Preview as student** — launches the real inspection on this exact scenario,
  with result recording suppressed so a preview never lands in anyone's
  competency record.

**Decoys are first-class.** An authored room where the only clickable things are
the faults teaches students to flag whatever highlights. The editor therefore
lets clean objects be tagged as anchors explicitly, and the save path warns
(does not block) when a scenario has faults but no decoys.

**Why a separate file from `RoomLayoutEditor.jsx`.** That editor is 955 lines
and authors the *correct* room — its output feeds `roomLayouts.js` and the
geometry validator. This one authors what is *wrong* with a room and its output
is a teaching artefact. Sharing the gizmo wiring would mean refactoring a
working admin tool to serve a second master; the duplication is the cheaper and
safer trade, and is noted here so it is a recorded decision rather than an
accident.

## Testing

- `fromScenario` — pure: returns the same `{ layout, anchors }` shape as
  `applyDefects`; derives `injected` from tagged anchors; ignores an anchor with
  an unknown `defectId` rather than emitting an ungradeable item; tolerates a
  scenario with zero faults.
- Scenario validation — rejects a bad tier, an unknown `defectId`, a negative
  child count, a missing name.
- Selection — a tier with authored scenarios picks one; a tier with none falls
  back to procedural; a failed fetch falls back to procedural.
- `authz.test.js` in the auth service must keep passing (all four new routes
  guarded).
- Existing inspection tests must be unaffected — the procedural path is
  unchanged.

## Out of scope

- Editing the base room geometry (that is the existing Room Layouts editor).
- Authoring new defect *categories*; the six from the change request are the
  fixed answer vocabulary the flag menu offers.
- Per-student scenario assignment, scheduling, or scenario versioning.
- Migrating the existing localStorage room-layout overrides to the server.
