# Folio Formatting, Arrivals Accuracy & Room Editor Rename — Design Spec

Source: panel feedback, three numbered items. The reference invoice is
`10 - References/FELISMINO-JANA-MARIE_GUEST-FOLIO.pdf` (a real Aureliscita
Grande Hotel folio for a 3-night stay, 5/21–5/25/2025).

Three independent sub-projects. Recommended landing order is **3 → 2 → 1**:
the rename is trivial, arrivals is self-contained, and the folio work carries a
schema migration.

---

## 0. Findings that shape this spec

**`computeTax()` is dead code.** `services/folio/src/lib/policies.js:62` computes
a tax total *and a per-component breakdown*, and nothing calls it.
`POST /api/folios/:id/charges` (`services/folio/src/routes/folio.routes.js:590`)
reads `taxAmountCents` from the request body, and `web/src/pages/Folios.jsx`
never sends it. **Every folio in the system therefore carries ₱0.00 tax**, and
the printed folio's "Add: Taxes" line has always been zero. Section 1 fixes this
as a consequence of decomposing tax, not as a separate item.

**Arrivals reads a lossy projection.** `/api/arrivals`
(`services/stay/src/routes/stay.routes.js:111`) queries `Stay` rows with
`status: 'PRE_ARRIVAL'`. Those rows exist only because
`services/stay/src/subscribers/redis.subscriber.js:27` created one on a
`reservation:confirmed` Redis message. A reservation confirmed while the stay
service was down, seeded directly, or confirmed before the subscriber attached
gets no `Stay` row and is **permanently invisible** to the arrivals list. There
is no reconciliation anywhere. This is the reported inaccuracy.

**Check-in already tolerates a missing stay.** `POST /api/check-in`
(`services/stay/src/routes/stay.routes.js:168`) creates the `Stay` when
`findFirst({ reservationId })` returns nothing. Checking in directly from a
reservation therefore needs **no backend change** — only a caller that has the
`reservationId`, `guestId` and `guestName`, all of which a reservation carries.

---

## 1. Folio

### 1.1 Tax components become real

**Current state:** one VAT rule per category in `TAX_RULES`
(`services/_shared/policies.js`), a single combined `taxAmountCents` column, and
no caller.

**Design:** `TAX_RULES` grows from one rule to four named components, rates read
from settings rather than hardcoded:

| Component         | Setting key                   | Default |
| ----------------- | ----------------------------- | ------- |
| VAT               | `tax_vat_percent`             | `12`    |
| Service Charge    | `tax_service_charge_percent`  | `10`    |
| Local Tax         | `tax_local_percent`           | `0`     |
| Real Property Tax | `tax_rpt_percent`             | `0`     |

VAT 12% and Service Charge 10% are the Philippine standards and reproduce the
reference exactly (₱25,350 × 12% = ₱3,042; × 10% = ₱2,535).

**Local Tax and Real Property Tax default to 0%.** The reference's values imply
1.85% and 14.33%, which are not standard rates and are specific to that
property. Inventing them would put fabricated tax on a student's bill. They are
editable, so the rows are genuinely computed — which is the point of choosing
real splits over decorative zero rows.

**Where the rates live:** a new `AppSetting` key/value model in the **folio**
service's own schema, mirroring the reservation service's `AppSetting`
(`services/reservation/src/prisma/schema.prisma:92`). Not fetched cross-service:
charge posting is a hot write path, and making every posted charge depend on the
reservation service being reachable would trade a formatting improvement for an
availability regression.

**This requires a gateway change.** `location /api/settings` currently proxies
*everything* under that prefix to the reservation service
(`services/gateway/nginx.conf:275`), so a folio-service settings route would be
unreachable as written. Two longer-prefix locations are added:

```nginx
location /api/settings/tax-rates { proxy_pass http://$up_folio; }
location /api/settings/hotel     { proxy_pass http://$up_folio; }
```

nginx resolves prefix locations longest-match-first, so these win over the
existing `/api/settings` without disturbing the add-on-surcharge and theme routes
behind it. `nginx.conf` is **baked into the gateway image** — this needs a
gateway rebuild, not a restart.

`computeTax` stays a pure function — rates are passed in, never read from the
database inside it, so `policies.test.js` needs no database.

**Vendoring:** `_shared/policies.js` is the source; the copy in each service's
`src/lib/` is refreshed per the `scripts/check-shared.sh` convention (CI and
pre-commit guard the drift). All ten copies are updated in the same commit.

### 1.2 The breakdown is persisted

**Design:** new nullable column on `FolioTransaction`:

```prisma
taxBreakdown Json?   // [{ name, rate, amountCents }], null for pre-migration rows
```

`POST /api/folios/:id/charges` calls `computeTax` when the caller does **not**
supply an explicit `taxAmountCents`, and stores both the component array and the
existing `taxAmountCents` sum. An explicit `taxAmountCents` still wins, so a
poster that **sends** its own figure keeps its current behaviour.

**Correction (2026-09-06, from the final branch review).** An earlier draft of
this sentence claimed the night audit was among them. It is not.
`services/audit/src/routes/audit.routes.js:202-210` posts `RM` charges with
**no** `taxAmountCents`, so its room charges now attract VAT 12% + Service
Charge 10% like any other untaxed post. That is the intended outcome — §0
identifies zero tax as the bug — but it has a consequence this spec did not
anticipate:

> `Reservation.totalEstimateCents` is `baseRate × nights` with **no tax**
> (`services/reservation/src/index.js:102-118`). A guest quoted ₱25,350 at
> booking now checks out owing ₱30,927, and any deposit was sized against the
> untaxed figure. A guest in-house across the deploy gets ₱0 tax on nights
> posted before it and 22% on nights after — one bill, two regimes.
> `GET /api/folios/daily-totals` `taxCents` also steps from zero to non-zero
> overnight, putting an unannotated discontinuity in revenue reports.

**Unresolved — for the product owner.** Whether reservation quoting should
become tax-inclusive, show tax as a separate line, or leave the gap as a
training-system quirk is a business decision outside what this spec was asked
to change. Nothing here resolves it.

**Backward compatibility is the hard requirement here.** `taxAmountCents`
remains the single source of truth for every total: `classifyTransactions`
(`services/folio/src/lib/folioSummary.js`), the daily-totals route, the
outstanding-balance guard and the check-out block all keep reading it and none
of them change. `taxBreakdown` is presentation detail layered on top.

Rows written before the migration have `taxBreakdown: null`. The print falls
back to attributing their whole `taxAmountCents` to VAT. **No existing folio's
total, balance or printed figure moves by one centavo.**

### 1.3 The printed folio is rebuilt to the reference

**Current state:** `/folios/:id/print`
(`services/folio/src/routes/folio.routes.js:1402`) renders a flowing list of
label/value lines with no rules or boxes, and a comment at line 1467 explicitly
declining the Tax1–4 slots.

**Design:** a fully bordered, tabulated A4 document reproducing the reference's
structure. pdfkit draws the grid explicitly (`doc.rect().stroke()` per cell)
rather than relying on text flow.

**Header block** — hotel name centred bold, then address, `Phone / Fax /
E-Mail`, `URL`, then `Invoice`.

**Guest/stay grid** — boxed cells, matching the reference row for row:

```
Folio No.      : <n>                        | Date  : <today>
Guest Name     : <name>                     |
Nationality | No. of Pax | Adult Child | G.R. Card No |
Date of Arrival | Date of Departure | Tariff
Time of Arrival |
```

`G.R. Card No` carries the confirmation number — InnSight has no physical
registration-card artefact, and the confirmation number is the identifier a guest
is actually asked for.

**Particular / Total body** — every section of the reference, in order:

| Reference section              | InnSight source                                            |
| ------------------------------ | ---------------------------------------------------------- |
| Room Charges → Room Charges    | `roomChargeCents` from `classifyTransactions`               |
| Room Charges → Less Discount   | negative `CHARGE` rows against a room code                  |
| Add : Room Tax → 4 components  | `taxBreakdown` summed across ROOM-category charges          |
| Add : Extra Charges            | `extraChargeCents` + `facilityChargeCents`                  |
| Add : Tax On Charges (Tax1–4)  | `taxBreakdown` summed across **non-room** charges           |
| Add : Transferred From Folio   | `TRANSFER` rows with a positive amount                      |
| Less : Flat Discount           | `ADJUSTMENT` rows carrying the discount charge code         |
| Less : Amount Paid             | `paymentsCents` − `refundsCents`                            |
| Less : Transferred To Folio    | `TRANSFER` rows with a negative amount                      |
| Adjustment                     | remaining `ADJUSTMENT` rows                                 |
| Total Charges / Payment / Balance | the right-hand rail, from `classifyTransactions`        |

**Tax1–4 are labelled by component, not by number.** The reference's `Tax1`…`Tax4`
are unnamed slots in that vendor's system; here they are VAT / Service Charge /
Local Tax / Real Property Tax applied to non-room charges. This fills the
section's four rows with meaningful data in the reference's shape rather than
printing four slots nobody can interpret.

**Footer** — `Remark`, `This Folio is in : <currency>`, `Bill To`, `Address`,
the amount in words (`centsToWords`, already used), the NOTICE TO GUESTS
paragraph, and the `CHECKOUT TIME` / liability agreement block.

**Address** uses the guest's `nationality`. `Guest`
(`services/guest/src/prisma/schema.prisma:10`) has no address field, and the
reference's own Address line reads only "Philippines". Adding a full address
column is scope this spec deliberately declines.

**Hotel identity** is configurable via the same folio `AppSetting` table
(`hotel_name`, `hotel_address`, `hotel_phone`, `hotel_fax`, `hotel_email`,
`hotel_url`), defaulting to InnSight PMS. **"Aureliscita Grande Hotel" and its
phone, e-mail and URL are NOT hardcoded** — they identify a real business, and
shipping them as system defaults would make every printed folio impersonate it.

**Deliberately not done:** the reference's logo image. There is no asset pipeline
for a property logo and no logo supplied; the header renders text only.

### 1.4 Settings surface

A "Tax rates" card on `web/src/pages/Settings.jsx`, following the existing
System Appearance card's shape: four percent inputs, admin/manager only,
`GET`/`PUT /api/settings/tax-rates` on the folio service, validating each value
as a number in `[0, 100]` — the same validation shape as
`PUT /api/settings/addon-fee-percent`.

A "Hotel identity" card alongside it for the header fields, on
`GET`/`PUT /api/settings/hotel`. Both are reachable only once the gateway
locations in §1.1 are added and the gateway image is rebuilt.

### 1.5 Folios page UI

**Current state:** `web/src/pages/Folios.jsx:222` opens with a bare "Folio id"
text input. There is no way to discover a folio without already knowing its UUID.

**Design:** mirror `web/src/pages/Guests.jsx` — the guest-profile layout, which
already solves exactly this problem and whose behaviour is documented in that
file's comments:

- A search bar (folio number or guest name), debounced 220ms with a monotonic
  request id, so a slow response for a shorter term cannot land after a fast one
  for a longer term.
- Three list modes — `browse` (recent folios), `suggesting` (live matches as
  table rows, not a floating dropdown), `selected` (list gone entirely, not
  narrowed to one row).
- Columns: Folio #, Guest, Status, Balance. Whole row is the control, with
  `role`/`tabIndex`/`onKeyDown` for keyboard access.
- The selected folio's existing ledger card, transactions, payments and posting
  forms render **below**, unchanged.
- `EmptyState` for no matches.

`?id=` deep links from the Arrivals page keep working: an `id` in the query
string selects that folio directly, exactly as today.

**Backend:** `GET /api/folios`
(`services/folio/src/routes/folio.routes.js`) gains:
- `?q=` — matches folios two ways, unioned: a case-insensitive match on
  `folioNumber` in the folio's own database, plus any folio whose `guestId` is
  returned by the guest service's existing
  `GET /api/guests/search?q=` (`services/guest/src/routes/guest.routes.js:47`).
- `guestName` and `balanceCents` on each row.

Guest names are not stored on `Folio` (only `guestId`), and the guest service has
**no bulk lookup** — only `GET /api/guests/:id`. Rather than issue one call per
row, add `GET /api/guests/batch?ids=a,b,c` returning `{ id, displayName }` pairs.
It must be declared **before** the `/guests/:id` route, or Express matches it as
a guest whose id is the literal string `batch` — the same ordering hazard
`/folios/outstanding` already documents in `folio.routes.js`.

If the guest service is unreachable the rows still render with folio number,
status and balance and a `—` name, rather than the list failing. A folio list
that 500s because a *name* could not be fetched would be a worse regression than
the missing search it replaces.

Balance is computed with `classifyTransactions` — the same classifier the print
and the check-out guard use, so the number in the list is the number on the bill.

---

## 2. Arrivals & Departures

### 2.1 Reservations become the source of truth

**Design:** `/api/arrivals` stays in the stay service (the gateway already routes
it there, `services/gateway/nginx.conf:289` — no gateway change, no rebuild).
Its implementation inverts:

1. Fetch `CONFIRMED` reservations whose `checkIn` falls in the window, from the
   reservation service via the existing `reservationCall`
   (`services/stay/src/routes/stay.routes.js:26`, already scoped
   `reservation.read`).
2. Left-join local `Stay` rows by `reservationId` in one `findMany`.
3. Drop any whose stay is already `IN_HOUSE`, `DEPARTED` or `NO_SHOW`.

A Redis outage can no longer hide an arrival, because arrivals no longer depend
on the projection Redis populates.

**Degraded mode:** if the reservation service is unreachable, fall back to the
current local `Stay` query and set `degraded: true` on the response. The UI shows
a warning strip. A short list that silently claims to be complete is the failure
mode this whole section exists to remove; replacing one silent wrong answer with
another would defeat it.

**Response shape** keeps every field the UI and check-in already consume — `id`,
`reservationId`, `guestId`, `guestName`, `expectedCheckIn`, `expectedCheckOut`,
`status` — and adds `confirmationNumber`, `nights`, `adults`, `children`,
`roomTypeCode`, and `stayId` (null when no stay row exists yet). Existing callers
keep working unchanged.

### 2.2 The date window, and the convention trap

`reservationListWhere` (`services/reservation/src/lib/listQuery.js:58`) treats
`from`/`to` as an **overlap** test — `checkIn < to AND checkOut > from` — and the
night audit's no-show sweep depends on the `to`-only form. Arrivals needs a
different question: *which bookings START in this window*.

**Two new params, `checkInFrom` / `checkInTo`, are added rather than
reinterpreting `from`/`to`.** Changing the existing semantics would break the
calendar and the audit. Both new params and the existing `to` write to
`where.checkIn`, so the builder must **merge** the constraints into one object
instead of overwriting — `to` currently assigns `where.checkIn = { lt: … }`
outright, and a naive addition would silently drop one bound.

**Day bounds use the UTC convention, not the local one.** `checkIn` is written
with `new Date('YYYY-MM-DD')` (`reservation.routes.js:134`) = UTC midnight, the
date-only-key convention documented in `services/_shared/date.js`. The current
`/api/arrivals` compares those values against `localDayBounds`, mixing the two
conventions the shared helper explicitly warns about. It happens not to
misfire in Asia/Manila (UTC+8) but is wrong in principle and breaks at negative
UTC offsets. The rebuilt endpoint uses UTC day bounds, matching how the values
are stored.

**Range parameter:** `?range=today|week|month`, resolved server-side to a
`checkInFrom`/`checkInTo` pair. `week` and `month` are rolling windows from
today, not calendar weeks/months — the desk's question is "who is coming in the
next 7/30 days", not "who is coming before Sunday".

**Row cap:** `LIST_LIMIT` is 500 (`reservation.routes.js:21`) and the route
already warns when a query hits it. A month of arrivals at this property's scale
is far under that, but the arrivals endpoint propagates the warning into
`degraded` rather than silently truncating.

### 2.3 Overdue arrivals

**Overdue arrivals — `checkIn` before today, still not arrived, not cancelled —
appear in every range**, above the in-range rows, with a distinct pill. This is
the other half of "should always show the expected arrivals": today's strict
window is why a guest who was due yesterday and never turned up vanished from
the desk's screen entirely instead of demanding action.

### 2.4 UI

`web/src/pages/Arrivals.jsx`:

- A segmented `Today | Week | Month` control in the **upper right of the Expected
  arrivals panel header**, as asked. Implemented in the existing `panel-head`
  pattern already used on `Guests.jsx`.
- Columns gain Confirmation (real confirmation number, not
  `reservationId.slice(0,8)`), Nights and Pax.
- Rows group under date subheadings when the range is wider than today.
- **Check-in works from every range**, using the existing modal and the existing
  `POST /api/check-in`. Checking in a guest whose stay row does not exist is
  already handled server-side (§0).
- A guest arriving on a future date can still be checked in — the desk does this
  for early arrivals — but the confirm dialog names the date so it is a
  deliberate act rather than a misclick.

**Departures are left alone.** `/api/departures` lists `IN_HOUSE` stays with
`expectedCheckOut` today. A departure cannot exist without an in-house stay, so
it has no equivalent projection blind spot. Its `localDayBounds` usage is
correct, because `expectedCheckOut` on a `Stay` is a real timestamp.

---

## 3. Rooms & Housekeeping → Hotel Room Information Editor

Rename only.

- `web/src/components/Layout.jsx:66` — sidebar label.
- `web/src/pages/Rooms.jsx:150` — page heading.
- Any other occurrence found by a repo-wide search of the old string.

The route stays `/rooms`. Changing it would break existing links, bookmarks and
the deep links other pages build, for no benefit — the URL is not the label.

---

## Testing

**Folio**
- `policies.test.js` — four components at configured rates; the reference's
  ₱25,350 room charge produces ₱3,042 VAT and ₱2,535 service charge exactly.
- `folioSummary.test.js` — unchanged assertions must still pass; this is the
  regression gate proving totals did not move.
- New: a transaction with `taxBreakdown: null` prints its full tax as VAT, and
  the folio's balance equals the pre-migration balance.
- New: components summed across many transactions equal `taxAmountCents` summed
  across the same transactions — the breakdown can never disagree with the total.
- Print route returns a PDF for a folio with zero transactions, and for one with
  every section populated.

**Arrivals**
- A `CONFIRMED` reservation with **no** `Stay` row appears in arrivals. This is
  the regression test for the reported bug and must fail against current `main`.
- A reservation whose stay is `IN_HOUSE` does not appear.
- A `CANCELLED` reservation does not appear.
- An overdue arrival appears in all three ranges.
- Reservation service unreachable → `degraded: true` plus local rows, not a 500.
- `checkInFrom`/`checkInTo` combined with the existing `to` produce a merged
  `where.checkIn` with both bounds intact.
- Existing `listQuery` overlap tests must still pass — the audit depends on them.
- Check-in from a reservation with no stay row creates the stay and returns 201.

**Routing**
- `GET /api/guests/batch?ids=` resolves names and is **not** swallowed by
  `/guests/:id` — a test asserting `batch` is never treated as a guest id.
- The two new gateway locations reach the folio service while `/api/settings/theme`
  and `/api/settings/addon-fee-percent` still reach the reservation service.

**Authorization**
- `authz.test.js` in the folio, guest and stay services enforces default-deny;
  every new route (`/api/settings/tax-rates`, `/api/settings/hotel`,
  `/api/guests/batch`, the widened `/api/folios`) is added to its table. Both
  settings writes are admin/manager only.

## Out of scope

- A guest address field.
- A property logo asset.
- Paging for the folio list (the existing 100-row cap stands).
- Changing the departures query.
- Changing the `/rooms` route path.
- Backfilling `taxBreakdown` onto historical transactions — the VAT fallback
  renders them correctly and rewriting posted financial records to improve a
  layout is not a trade worth making.
