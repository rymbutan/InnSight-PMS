# Managing Walk-Ins & Non-Guest Sales — Design Spec

Source: `Changes to be made in the System.pdf`, section 2 ("Managing Walk-Ins &
Non-Guest Sales"), the second of three independent sub-projects in that document.
Sub-project 1 (Reservation & Dashboard Updates) is complete; sub-project 3 (3D
Room Simulation) follows this one.

**Placeholder pricing:** every peso figure introduced by this spec other than the
two the source document states (polo ₱200, long-sleeve ₱150) is a placeholder
chosen to be plausible. They live in seed data and are editable from the existing
admin UI; confirm real figures with the property before demo.

## 1. Visitor / non-hotel-guest labelling

**Current state:** the flow the document asks for already exists and already
behaves correctly. `POST /api/folios/amenity-sale`
(`services/folio/src/routes/folio.routes.js:110`) opens a `WALKIN`-type folio
with no `stayId` and no room reference, so no room assignment is ever
prompted. The room-assignment path (`POST /api/walk-in`,
`services/stay/src/routes/stay.routes.js:255`) is a separate route.

**Gap:** terminology only. The UI calls this a "Walk-in sale"; the panel asked
for the words "visitor" / "non-hotel guest".

**Design:** copy changes in `web/src/pages/Amenities.jsx` — panel heading to
"Visitor sale (non-hotel guest)", the name field to "Visitor name", and the
explanatory line to state plainly that visitors are not hotel guests and need
no room. Where a folio's `WALKIN` type is rendered to staff, display it as
"Visitor". No schema change, no backend change.

**Deliberately not done:** adding a `guestType` column. The `WALKIN` folio type
already carries this distinction; a parallel field would be a second source of
truth for the same fact.

## 2. Laundry priced per piece

**Current state:** one `LAUNDRY` facility, `PER_USE`, ₱300, unit "per load".

**Design:** a laundry *ticket* with multiple garment lines, posting as one
charge.

- **Catalogue:** per-garment SKUs seeded as `Facility` rows, category
  `LAUNDRY`, `pricingModel: PER_USE`, unit "per piece":
  `LDY_POLO` ₱200 and `LDY_LONGSLEEVE` ₱150 (both from the source document),
  plus `LDY_TROUSERS` ₱180, `LDY_DRESS` ₱250, `LDY_BEDSHEET` ₱220
  (placeholders).
- **Retire the old SKU:** set the per-load `LAUNDRY` row `active: false` rather
  than deleting it. Historical `FolioTransaction` rows carry `chargeCode:
  'LAUNDRY'`, and deleting the facility would orphan the label those rows
  display.
- **New endpoint** `POST /api/folios/laundry-sale` in the folio service:
  ```
  { items: [{ facilityCode, qty }], guestName?, method, stayId? }
  ```
  Every line is priced from inventory server-side — a client-supplied amount is
  never trusted, matching `amenity-sale`. Posts **one** `CHARGE` with
  `chargeCode: 'LD'` (the seeded laundry charge code) whose description
  itemises the ticket, e.g. `Laundry: 2× Polo, 1× Long-sleeve shirt`.
  - With no `stayId`: opens a `WALKIN` folio, posts charge + full payment,
    closes it — identical shape to `amenity-sale`.
  - With a `stayId`: posts the charge to that stay's existing open folio and
    takes no payment (it settles at checkout with the rest of the folio).
    Returns 404 if no open folio exists for the stay.
- **Pure helper** `services/folio/src/lib/laundryTicket.js` —
  `buildLaundryTicket(lines)` returning `{ totalCents, description }`, so the
  money and the guest-visible wording are unit-testable without a database.
- **UI:** a "Laundry ticket" panel in `Amenities.jsx` — add garment lines with
  quantities, see a running total, then post to a visitor or an in-house stay.

## 3. Divisible function hall

**Current state:** `Facility` has no parent/child relation
(`services/inventory/src/prisma/schema.prisma:99`); every facility is an
independent flat unit. The booking clash check
(`services/inventory/src/routes/inventory.routes.js:777`) tests only
`facilityId`, so a hall and a room carved out of it are unrelated as far as the
system is concerned.

**Design:**

- **Schema:** `Facility.parentCode String?` plus a self-relation
  (`parent` / `children`). Seed `HALL_A`, `HALL_B`, `HALL_C` with
  `parentCode: 'HALL'`, each `PER_HOUR` ₱60,000/hr, capacity 40 (the parent
  `HALL` is capacity 120 at ₱150,000/hr).
- **Conflict rule:** a booking occupies a set of **leaf** spaces — for a
  childless facility, itself; for a parent, all of its children. Two bookings
  conflict when their leaf sets intersect over an overlapping time range.
  This yields exactly the semantics a venue needs:
  - whole hall vs. section A → conflict (both claim leaf A)
  - section A vs. section A → conflict
  - section A vs. section B → **no** conflict (disjoint leaves)
  - whole hall vs. whole hall → conflict
- **Application-level check:** the existing clash query widens from
  `facilityId = X` to "any CONFIRMED booking whose leaf set intersects this
  one's", returning the same 409 with a message naming the space that actually
  clashes.
- **Database-level backstop:** a `FacilitySlotLock` table, one row per
  (booking, leaf facility, time range), with
  ```sql
  EXCLUDE USING gist ("facilityId" WITH =, tsrange("startAt","endAt",'[)') WITH &&)
  ```
  Locks are written in the same transaction as the booking and deleted when it
  is cancelled, so a cancelled slot frees immediately. `btree_gist` is already
  installed in the inventory database.

  **Why a lock table rather than a constraint on `FacilityBooking` directly:**
  one booking can occupy several leaves, and sibling sections must *not*
  exclude each other. No exclusion constraint over `FacilityBooking.facilityId`
  can express "parent excludes each child but children don't exclude one
  another"; decomposing a booking into one row per occupied leaf makes the rule
  a plain equality overlap, which an exclusion constraint expresses exactly.
  This mirrors how the reservation service backstops double-booking
  (`20260729000100_no_double_booking`), adapted to a many-leaves-per-booking
  relation.
- **Pure helper** `services/inventory/src/lib/conflictScope.js` —
  `leafFacilityIds(facility, children)` — unit-tested.
- **UI:** sub-rooms listed indented under their parent in the amenities table,
  so the hierarchy is visible to staff.
- **Half-open ranges** (`'[)'`): a booking ending at 14:00 and another starting
  at 14:00 do not overlap, matching how back-to-back function bookings work.

## 4. Amenity pricing and service detail

Seed-data work; the admin UI already supports creating and pricing facilities.

- New `VALET` category (added to `CATEGORIES` in `Amenities.jsx`) and a
  `VALET` facility, `PER_DAY` ₱15,000 (placeholder).
- Split the single "Spa & Massage" SKU: `SPA` becomes spa facility access,
  with `MASSAGE_60` (₱120,000) and `MASSAGE_90` (₱170,000) as distinct
  services (placeholders).
- Populate `Facility.description` for every amenity so the panel shows what
  each service actually includes. The column already exists and is unused.

## 5. Night audit — combine all daily sales

**Current state:** the aggregation the document asks for is already implemented
and correct. `GET /api/folios/daily-totals`
(`services/folio/src/routes/folio.routes.js:250`) sums every
`FolioTransaction` for the date across all folio types — so visitor/amenity
sales are already included — splitting room revenue from other revenue by the
charge code's *category*, and `POST /api/audit/run`
(`services/audit/src/routes/audit.routes.js:264`) persists all four figures onto
the `BusinessDay` row. Verified against the live database: `BusinessDay` has
both `roomRevenueCents` and `otherRevenueCents` columns.

**Gap:** `web/src/pages/Audit.jsx` renders only `roomRevenueCents`. Amenity,
laundry, spa and visitor sales are counted, stored, and then not shown.

**Design:** display what is already computed — "Other revenue" and "Total
revenue" metrics on the current-day panel, and an "Other revenue" column in the
history table. UI only; no backend change.

## Testing

- `buildLaundryTicket` — unit tests: single line, multiple lines, quantity
  multiplication, blank/zero-quantity lines rejected, description wording.
- `leafFacilityIds` — unit tests: childless facility returns itself, parent
  returns its children, parent with no children behaves as a leaf.
- Booking conflict matrix — integration tests over the four cases above
  (hall vs. section, section vs. same section, section vs. sibling section,
  back-to-back bookings at a shared boundary).
- Exclusion constraint — a test asserting the database rejects an overlapping
  leaf lock, so the backstop is proven rather than assumed.
- Laundry sale endpoint — integration test for the walk-in path and the
  in-house-stay path, plus authoritative pricing (a client-sent amount is
  ignored).
- Existing `authz.test.js` in both services must keep passing; every new route
  carries a `requireRole(...)` guard.

## Migration safety

Both new migrations re-run on every container start via `scripts/db-init.sh`,
so both must be idempotent: `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT
EXISTS`, `DROP CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`, and
`ON CONFLICT DO NOTHING` for seeded rows.

Adding the exclusion constraint to a database that already contains
overlapping bookings would fail. The migration therefore includes the
diagnostic query for finding offending rows, in the style of
`20260729000100_no_double_booking`.
