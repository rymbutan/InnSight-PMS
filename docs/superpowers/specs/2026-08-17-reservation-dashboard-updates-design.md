# Reservation & Dashboard Updates — Design Spec

Source: `Changes to be made in the System.pdf`, section 1 ("Reservation & Dashboard
Updates"), one of three independent sub-projects in that document. The other two
(Managing Walk-Ins & Non-Guest Sales; 3D Room Simulation Gameplay Mechanics) are
separate specs, sequenced later.

## 1. Calendar — length-of-stay indicator

**Problem:** `Calendar.jsx` already colors each reservation bar by status
(confirmed / in-house / checked-out / canceled / pending, see the legend at
`Calendar.jsx:486-501`) and already computes `span` (nights) per bar
(`Calendar.jsx:118`). There is no visual cue for stay length today.

**Design:** Add stay length as a *second*, independent cue rather than
replacing the status color (which other workflows depend on). A thin accent
stripe on the left edge of each bar, banded by `span`:

| Band | Nights | Stripe color |
|---|---|---|
| Short | 1–2 | (light accent) |
| Medium | 3–6 | (mid accent) |
| Long | 7+ | (dark accent) |

Add 3 corresponding legend swatches next to the existing status legend.

**Scope:** Frontend only — `web/src/pages/Calendar.jsx` and its stylesheet.
No backend or schema change; `span` is already available on the bar object.

## 2. Guest folio / receipt

**Problem:** `GET /api/folios/:id/print` (`services/folio/src/routes/folio.routes.js:855`)
already renders a PDF via `pdfkit`, but only as a bare transaction ledger — no
hotel header, guest/stay info, or grouped totals. Confirmation emails are
already fully implemented elsewhere and need no changes.

**Reference format:** the provided sample folio (Aureliscita Grande Hotel
invoice) — header block, guest/stay info grid, itemized Particulars, Total
Charges → Payments → Balance, amount-in-words, legal notice footer.

**Design:** Rebuild the print route's PDF layout to match that structure,
populated from real InnSight data:

- **Header block:** hotel name/address/contact (config constant).
- **Guest/stay grid:** guest name and nationality (`Guest.nationality`,
  already on the model), no. of pax / adults / children
  (`Reservation.adults`, `Reservation.children`, already on the model),
  arrival/departure date+time (`Stay.actualCheckInAt`,
  `Stay.actualCheckOutAt`), tariff (derived from the room `CHARGE` line
  total ÷ nights).
- **Particulars ledger**, grouped from `FolioTransaction` by `type` /
  `chargeCode` — all types already exist in the schema, no new enum values
  needed:
  - Room Charges: `CHARGE` transactions with the room charge code.
  - Taxes: all `TAX` transactions, listed by their own `chargeCode`/description
    (not forced into the reference's fixed Tax1–4 slots — InnSight doesn't
    model a fixed set of tax types, so this is a grouped list instead).
  - Extra Charges: all other `CHARGE` transactions (amenities, add-ons, etc.).
  - Total Charges (sum of the above).
  - Payments: `PAYMENT` transactions.
  - Adjustments: `ADJUSTMENT` transactions.
  - Balance = Total Charges − Payments − Adjustments.
- **Deviations from the literal reference**, since InnSight has no matching
  concept: no "G.R. Card No." row (`Reservation.confirmationNumber` is used
  in its place); no guest Address line (omitted — not a captured field);
  "Transferred From/To Folio" sections omitted entirely rather than shown as
  fake zero rows (folio-to-folio transfer isn't a supported workflow here,
  even though the `TRANSFER` transaction type exists in the enum).
- **Amount in words:** new small pure helper (e.g. `centsToWords(amountCents)`),
  unit-tested directly (no PDF rendering needed to test it).
- **Data fetching:** guest and stay details are fetched from their respective
  services via the existing `serviceCall.js` pattern, best-effort — a failed
  lookup renders as `—` in that field rather than failing the whole print,
  since staff need to print folios during an audit even if another service is
  degraded.

**Scope:** `services/folio/src/routes/folio.routes.js` (print route rewrite),
a new `centsToWords` helper + unit test.

## 3. Terminology sweep

**Problem:** the doc calls out `"in-house"` → `"in-house guest"` as one
example of non-standard wording; the user has asked for a broader review of
guest-facing copy against standard hotel-industry terminology, not just this
one term.

**Design:** two-step process, not a blind bulk find/replace:

1. Grep all user-facing copy (JSX text nodes, labels, headings, tooltips,
   aria-labels) across `web/src` for candidate non-standard terms — starting
   from the ~52 existing `"in-house"` hits, then scanning more broadly for
   other informal or non-industry-standard phrasing.
2. Produce a reviewable list (current wording → proposed wording, file:line)
   for the user to approve before any text is changed.

**Explicitly out of scope:** the `IN_HOUSE` reservation/stay status enum and
any other code identifiers — canonical spelling there is unchanged
([[auth-security-model]] / project convention already fixes `CANCELLED` and
`FRONT_DESK` spellings the same way; this sweep only touches display copy).

**Scope:** `web/src` only, copy-level edits after user sign-off on the list.
No backend change.

## 4. Reservation add-ons with configurable fee

**Problem:** `NewReservation.jsx`'s wizard already has an "Add-ons" step
(`NewReservation.jsx:8`, stub body at `NewReservation.jsx:528-533`: *"No
add-ons configured. Skip to the next step to take payment."*) that does
nothing today. The doc wants a text box for a special request (e.g. "a
specific brand of cake") with a percentage charge applied on top.

**Design:**

- **Add-on entry (reservation-time):** the Add-ons step lets staff add one or
  more line items, each `{ description, costCents }` (e.g. "Chocolate cake,
  specific brand — ₱850"). Stored as a JSON array field on `Reservation`
  (`addOns Json?`, mirroring the existing `tags Json?` pattern on `Guest` —
  no new table needed for what is a small, reservation-scoped list).
- **Fee application:** each add-on's charged total = `costCents × (1 +
  feePercent / 100)`, computed at posting time (not stored pre-computed, so a
  later fee-percent change never rewrites history).
- **Fee percentage storage (admin-editable):** since there is no settings/config
  table anywhere in the codebase today, add one minimal generic table to the
  reservation service:
  ```prisma
  model AppSetting {
    key       String   @id
    value     String
    updatedAt DateTime @updatedAt
  }
  ```
  Seed one row: `key: "addon_fee_percent", value: "10"`. Two endpoints:
  `GET /api/settings/addon-fee-percent` (any staff) and
  `PUT /api/settings/addon-fee-percent` (admin-only — same role-guard
  convention as `PATCH /facilities/:code` / `PATCH /room-types/:code` in the
  inventory service, i.e. an admin role group, not general front-desk).
  UI: a single inline-editable field (reusing the existing inline-edit
  pattern from `Amenities.jsx`'s facility pricing) placed on the Add-ons step,
  visible/editable only to admin roles.
- **Posting to folio:** add-ons are not charged at reservation time — they
  post as `CHARGE` `FolioTransaction`s (chargeCode `ADD_ON`) when the stay's
  folio is created at check-in, alongside room and other charges, using the
  existing charge-posting path.

**Scope:** `services/reservation` (new `AppSetting` model + migration, new
`addOns` field on `Reservation`, new settings endpoints), `services/folio` or
check-in flow (post add-on charges at folio creation),
`web/src/pages/NewReservation.jsx` (Add-ons step UI + fee display),
`web/src/pages/Amenities.jsx`-style inline-edit control reused for the fee
setting.

## Testing

- `centsToWords` — unit tests across representative amounts (zero, whole
  thousands, centavos, large values).
- Add-on fee math — unit tests: fee applied correctly, fee-percent changes
  don't retroactively alter already-posted charges.
- Folio print route — integration test asserting the rebuilt sections render
  with correct totals for a fixture folio (charges/taxes/payments/adjustments).
- Calendar band assignment — unit test on the pure function mapping `span` →
  band, at the 2/3 and 6/7 boundaries.
- Terminology sweep — no automated test; verified by the reviewed list itself.

## Open items carried into implementation

- Exact hotel header details (name/address/contact) for the receipt — use
  placeholder config constants; confirm final copy with the user before
  shipping.
- Terminology sweep candidate list is produced and approved during
  implementation, not enumerated in this spec.
