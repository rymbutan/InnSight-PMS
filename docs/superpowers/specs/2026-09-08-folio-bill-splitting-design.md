# Splitting the bill — percentage and equal

**Date:** 2026-09-08
**Service:** folio
**Status:** implemented 2026-09-08

## The problem

The folio page has a button labelled `Split bill — add folio`. It opens an empty
second folio on the stay and stops there. Splitting is then done by hand, one
charge at a time, through the per-line `Move` dropdown that calls
`POST /api/folios/:id/transfer`.

That is line-item reassignment, not bill splitting. A front desk asked to divide
a stay 60/40 between two payers, or three ways equally, has no way to do it: every
charge would have to be moved individually, and any charge whose value does not
divide cleanly cannot be divided at all, because `transfer` moves whole
transactions only.

This replaces that with a real split offering two methods — **equal** and **by
percentage** — that divides every charge on the folio proportionally.

## What a split produces

Per-line proportional. Every charge on the source folio is divided by the shares,
so each payer's folio keeps the full itemisation rather than a single opaque
"share of bill" line.

```
Source folio F-001                Split 60 / 40
  Room        ₱5,600      →     F-001 (60%)            F-002 (40%)
  Minibar     ₱1,200              Room        ₱3,360     Room        ₱2,240
  Restaurant  ₱3,200              Minibar     ₱  720     Minibar     ₱  480
                                  Restaurant  ₱1,920     Restaurant  ₱1,280
```

The source folio is one of the payers and keeps its own share. Target folios are
created by the split itself: the operator says "3 ways" and gets three folios,
rather than opening siblings first.

## Why transfer pairs, and not the alternatives

The existing `lib/transfer.js` records a move as a **reversing pair** — a negative
on the source, a positive on the destination, each naming the other folio. Its
header explains why, and that reasoning governs this design too: a folio that
silently loses a line it once carried is not an auditable bill, and the guest may
already be holding a printed copy of it.

Two alternatives were rejected:

- **Reassigning `folioId`** on the transaction. Same objection: the source folio's
  history silently changes under a document already in the guest's hands.
- **Posting fresh CHARGE lines on the targets plus one credit ADJUSTMENT on the
  source.** This loses the `reversalOf` linkage back to the originating charge,
  and an ADJUSTMENT is not charge-side revenue, so the split would quietly
  reclassify income in every report keyed off `ChargeCode.category`, the night
  audit included.

Building on transfer pairs also means the rest of the service needs no changes:
`classifyTransactions` already counts `TRANSFER` exactly like `CHARGE`
(`folioSummary.js:38`), a fact its own comment records was learned the hard way —
ignoring it once produced "a split bill that adds up to the wrong total on both
halves."

## Component 1 — `services/folio/src/lib/split.js`

Pure arithmetic, no Prisma, no HTTP, so the maths that decides what a guest is
billed is testable without a database. Mirrors how `transfer.js` and
`folioSummary.js` are already structured.

### `allocate(totalCents, shares) -> BigInt[]`

Largest-remainder method:

1. Compute each share's exact quotient as a numerator/denominator pair in `BigInt`
   — never floating point, because money must not round-trip through a float.
2. Floor each to whole cents.
3. Distribute the leftover cents, one each, to the largest fractional remainders.
4. Ties break toward the **earliest** share, so the result is deterministic and
   the same split run twice produces identical folios.

**Guarantee:** `sum(allocate(t, s)) === t` for every total and every share vector,
including totals smaller than the number of shares, and negative totals (a credit
line splits too).

`₱1,000.00` three ways equally → `33334 / 33333 / 33333` — the odd centavo
goes to the earliest share, per the tie rule above.

Equal is percentage with an equal share vector. `method` only decides how the
vector is built, so there is one allocation path and one set of guarantees.

### `planSplit({ transactions, targets, folioNumbers, payerNames, sourceFolioId })`

Returns the full set of transaction rows to write. For each splittable line it
calls `allocate` on the line's **net remaining** amount (see Component 2), then
emits one `planTransfer`-shaped pair per target that receives a non-zero share.

Lines excluded from a split, and why:

| Type | Reason |
|---|---|
| `PAYMENT`, `REFUND` | Money already taken from a specific payer. Moving it would misattribute who paid. The transfer route already refuses these. |
| `TRANSFER` | A transfer cannot itself be transferred — the existing guard. Its effect is already folded into the source line's net remaining. |
| net remaining of `0` | Fully split already. Nothing to divide. |

A target whose share rounds to zero cents on a given line gets **no row** for that
line, rather than a zero-value pair. Zero-value rows are noise on a printed folio.

## Component 2 — net remaining, so a folio can be split twice

A split does not consume the original charge; it posts negatives beside it. After
a 60/40 split, folio F-001 holds:

```
  Room                                    ₱5,600   (CHARGE)
  Room — transferred to folio F-002      -₱2,240   (TRANSFER)
                                        ─────────
  net                                     ₱3,360
```

So a second split must divide `₱3,360`, not `₱5,600`. Splitting face value again
would move money that is no longer there and leave both folios wrong.

`planTransfer` already sets `reversalOf: tx.id` on both halves of a pair, so the
linkage needed to compute this exists:

```
netRemaining(tx) = tx.amountCents
                 + Σ (TRANSFER rows on this folio where reversalOf === tx.id)
```

Tax nets by the same rule against `taxAmountCents`.

## Component 3 — tax, and the print-fidelity trap

`planTransfer` sets no `taxBreakdown` on its rows. `folioPrintModel.taxByComponent`
handles a row with no breakdown by falling back to the breakdown of the row named
by `reversalOf`, negated (`folioPrintModel.js:44-52`).

On a **receiving** folio that fallback silently misses: the originating charge
lives on the source folio, so it is absent from the `byId` map built from this
folio's own transactions. `original` is null, no rows are found, and the code
takes its last-resort branch — **the whole transferred tax prints as VAT**, losing
the component split. Correct in total, wrong in composition, on every folio that
receives a share.

Therefore the split writes an **explicit** `taxBreakdown` on both halves of every
pair: proportionally scaled and positive on the destination, negated on the
source. The void route already sets an explicit negated breakdown for exactly this
class of reason, so this follows established practice in the service rather than
inventing any.

Each row's breakdown is itself allocated with `allocate`, per component, so the
components of a row sum to that row's `taxAmountCents`. Without that second-level
allocation the printed folio's tax section disagrees with its own balance — which
`taxByComponent` would then paper over by dumping the difference on VAT.

The breakdown is computed **once, for the receiving half, and negated** for the
source half. Implementation found this the hard way: allocating each half
independently reads the original's positive components for both, so reconciling
that positive sum against the source half's negative tax dumps the whole
difference on one component. A three-way split of ₱220.00 tax printed the
source's share as `vat -106.66 / service charge +33.33` — the right total, an
invented composition, and a positive service charge on a line that gives money
away. Summing correctly is what hid it; only a per-component assertion catches
it.

Breakdown amounts are written as **decimal strings**, per the `taxBreakdown` column
comment: JSON cannot carry `BigInt`.

## Component 4 — who each folio bills, and saying so on the document

A split is only half-done if the resulting documents cannot tell you who they
bill. Today they cannot: `folioPrintModel` derives one name —
`stay?.guestName || reservation?.guestName` — and prints it as both
`meta.guestName` and `footer.billTo`. Every folio on a stay therefore prints the
*same* name, so a bill split between two payers produces two documents that both
claim to bill the same person and differ only in their totals.

### `Folio.payerName`

A nullable `payerName` column on `Folio`, set per payer when a split is made. A new
Prisma migration; `db-init.sh` runs `migrate deploy`, so it applies on the normal
startup path.

Nullable on purpose: every folio that exists today, and every folio opened outside
a split, has no distinct payer and correctly falls back to the stay's guest.

Names are supplied by the operator, not derived. A co-payer is often not a guest
in the system at all — a company, an employer, a friend settling the bar tab — so
this is a plain string on the folio and not a `guestId` reference. It is trimmed,
capped at 120 characters, and required for every payer in a split so no folio is
left ambiguous.

### What changes on the document

The printed folio already has both lines this needs, so no layout work:

| Line | Today | After |
|---|---|---|
| `Bill To` (`folio.routes.js:1825`) | the stay's guest, on every folio | `folio.payerName` when set, else the stay's guest |
| `Remark` (`folio.routes.js:1821`) | always blank | the split note |

`meta.guestName` deliberately keeps printing the **stay's** guest. Who occupied the
room and who is settling this folio are different facts, and the document has a
distinct line for each. Overwriting `guestName` with the payer would misstate the
stay itself.

The split note names the co-payers, so each half of a split says what it is part
of and who holds the other part:

```
Bill To               :  Bartolome Vendiola
Remark                :  Split bill — 40% of folio F-001. Shared with:
                         Arym Vendiola (60%, folio F-001).
```

And on the other folio:

```
Bill To               :  Arym Vendiola
Remark                :  Split bill — 60%, folios F-002. Shared with:
                         Bartolome Vendiola (40%, folio F-002).
```

The note is derived at print time from the folio's own TRANSFER rows and the
`payerName` of the folios named in them, not stored as frozen prose — a payer
renamed after the split then prints correctly, and the note cannot drift from the
transactions it describes.

### Transfer line labels

`planTransfer` writes `— transferred to folio F-002`. With payers named, the
counterpart's name goes in the label too, so a line in the existing "Transferred
To Folio" section reads as a person rather than a document number:

```
Room — transferred to folio F-002 (Bartolome Vendiola)
```

Done by giving `planTransfer` an **optional** labels argument alongside its
existing `folioNumbers` map. Optional so the current transfer route is unaffected
until it chooses to pass one — and it should, since a manual `Move` benefits from
naming the payer identically. One description builder, used by both paths.

## Component 5 — `POST /api/folios/:id/split`

Guarded with `CASHIER` (`['ADMIN','MANAGER','FRONT_DESK']`), matching `transfer`.

**Request**

One shape for both methods: `payers[0]` is the source folio, and `percent` is
absent for `EQUAL` because the server derives equal shares itself rather than
trusting a client to divide 100 by 3.

```jsonc
{
  "method": "PERCENT",                                  // or "EQUAL"
  "payers": [
    { "payerName": "Arym Vendiola",      "percent": 60 },  // the source folio
    { "payerName": "Bartolome Vendiola", "percent": 40 }   // a folio the split opens
  ]
}
```

**Validation** — every one of these is a 400 with a specific message, never a
generic failure:

- `method` is one of `EQUAL`, `PERCENT`.
- `payers` is an array of 2–8 entries.
- Every entry has a non-empty `payerName` after trimming, at most 120 characters.
  A split whose folios cannot say who they bill is the thing this is meant to fix,
  so an unnamed payer is rejected rather than defaulted.
- `EQUAL`: no `percent` is read; shares are derived as `ways = payers.length`.
- `PERCENT`: every `percent` is a number summing to exactly `100`,
  compared as integers scaled by 100 so `33.33 + 33.33 + 33.34` is accepted
  without a float epsilon. Every share must be **greater than zero**: a payer
  owing nothing does not need a folio opened for them, and a 0% entry is far
  likelier to be an unfinished form than an intention. (Distinct from a share
  that rounds to zero cents on one *line* while still owing on others — that is
  normal and handled per line.)
- The source folio exists, is `OPEN`, and has a `stayId`. A folio with no stay is
  a walk-in POS sale, and the transfer guard already refuses to move charges off
  one — a split must refuse for the same reason.
- The folio has at least one splittable line with non-zero net remaining.

**Behaviour** — one `prisma.$transaction` covering everything, so a split can
never half-apply and invent or destroy money:

1. Create one sibling folio per payer after the first, copying `stayId`,
   `guestId`, `type` and `currency` from the source, each with its own
   `payerName`.
2. Set the **source** folio's `payerName` from `payers[0]`. Without this the
   folio keeping the largest share is the one document that still cannot say who
   it bills.
3. Read the source folio's transactions, compute net remaining per line.
4. `planSplit`, then create every row with `sourceSystem: 'split'` and
   `postedBy` from `req.user`.

`sourceSystem: 'split'` rather than `'transfer'` so the audit trail distinguishes
a proportional split from a manual one-line move.

**Folio numbering.** `nextFolioNumber()` is `F-${Date.now()}-${random(0..999)}`.
Creating several folios inside one transaction runs well within a single
millisecond, leaving a ~1-in-1000 collision per pair against a `@unique` column —
which would abort the whole split. The split generates distinct numbers by
construction rather than relying on that odds, and the helper is reused, not
reimplemented.

**Response** `201` with the created folios and the transactions written.

### Dry run — `{ "dryRun": true }`

The same endpoint, same validation, same arithmetic, but it opens no folios and
writes no rows. Returns each payer's resulting total and which payer absorbs the
odd cent.

This exists so the dialog's live preview is computed by the code that will
actually do the work. The alternative — reimplementing `allocate` in the web
bundle — cannot be made safe here: `check-shared.sh` guards drift only between
`services/_shared/*.js` and vendored copies under `services/*/src/*`, so a copy
under `web/src/lib/` would be unguarded, and web is ESM against the services'
CommonJS, so a byte-identical vendored copy is not possible anyway. A second
implementation of money-rounding that nothing checks for drift is precisely the
bug this design is meant to avoid, and the number the operator sees before
confirming must be the number the server writes.

Wrapped in a read-only `$transaction` so a dry run cannot mutate even by
accident.

**Event** `folio:transferred` on Redis, the channel the existing transfer already
publishes and which the web live-refresh layer already forwards. Payload carries
`stayId` and the affected folio ids. No new channel: adding one means touching
`inventory/src/index.js` LIVE_CHANNELS, `useLiveEvents.js` and `notifications.js`
together, and there is nothing a split needs to say that this channel does not
already mean.

## Component 6 — the honest-void fix

`reversalOf` carries two meanings: "this row voids that row" (the void route) and
"this row is half of a transfer pair for that row" (`planTransfer`).

The void route's guard is:

```js
const existingReversal = await prisma.folioTransaction.findFirst({
  where: { reversalOf: original.id },
});
if (existingReversal) return res.status(409).json({ error: 'Transaction has already been voided.' });
```

Because a transfer pair sets `reversalOf`, a **transferred** charge already trips
this today and is told it "has already been voided" — which it has not. A split
posts up to seven pairs per line, so it makes a rare, confusing message common.

The refusal is right: a charge whose money has been moved elsewhere must not be
voided out from under the folios now carrying it. Only the **reason** is wrong.
The guard becomes type-aware and reports the real cause:

- a non-`TRANSFER` reversal → `409 Transaction has already been voided.` (unchanged)
- a `TRANSFER` reversal → `409 This charge has been split or transferred to
  another folio. Void it from there, or reverse the split first.`

Scope note: this fixes the message, not the behaviour. Making a split reversible
is deliberately out of scope, and is recorded under Not in scope below.

## Component 7 — UI

Replaces the `Split bill — add folio` button in `web/src/pages/Folios.jsx:456`. The
per-line `Move` control stays: one-off manual reassignment is still a real need and
is not what a proportional split is for.

```
┌──────────────────────────────────────────────────────────┐
│  Split folio F-001                                       │
│                                                          │
│   Method    ( ) Equally   (•) By percentage               │
│                                                          │
│   Payer                        Share      Gets           │
│   [ Arym Vendiola        ]     [ 60 ] %   ₱6,720         │
│     this folio (F-001)                                   │
│   [ Bartolome Vendiola   ]     [ 40 ] %   ₱4,480         │
│     a new folio                                          │
│   [ + add a payer ]                                      │
│                              ─────────────────────       │
│                                100 %     ₱11,200         │
│                                                          │
│   ⓘ  ₱5,000 already paid on this folio stays here —      │
│      a payment cannot be reassigned.                     │
│                                                          │
│   Each folio prints its payer on its Bill To line.       │
│                                                          │
│                      [ Cancel ]  [ Split bill ]          │
└──────────────────────────────────────────────────────────┘
```

- **Equally** collapses the percentage inputs to a number-of-ways stepper and
  shows the resulting per-folio total, including which folio absorbs the odd cent
  so the operator is never surprised by a 1-cent asymmetry. The payer name fields
  stay — an equal split still needs to know who the halves belong to.
- The first payer row is labelled as **this folio** and pre-filled with the stay's
  guest name, since the person already in the room is nearly always one of the
  payers. Every other row is a folio the split will open.
- Payer names are required; `Split bill` stays disabled while any is blank, and
  the row itself shows why rather than only the footer.
- The live preview comes from the **dry-run call**, debounced (~250ms) while the
  operator types, so the figures shown are the server's own arithmetic rather
  than a second implementation that could round differently. See the dry-run
  section for why a shared client-side copy is not an option here.
- While a dry run is in flight the previously shown figures stay put, greyed,
  rather than blanking — a total that flickers on every keystroke reads as
  instability in the numbers themselves.
- `Split bill` is disabled until the shares are valid, with the reason stated
  inline rather than on submit.
- The payments notice appears only when the source folio has a payment or refund.
- On success: toast naming the folios created, and the page reloads the stay's
  folios so the new siblings appear.

## Testing

`services/folio/src/lib/split.test.js`, in the style of the existing
`transfer.test.js` and `folioSummary.test.js` (`node:test`, `node --test`):

- `allocate` sums exactly for awkward divisors — 3, 6, 7 ways of totals ending in
  every remainder class.
- Remainder placement is deterministic and lands on the earliest largest
  remainder; the same input twice gives identical output.
- Totals smaller than the share count, a zero total, and a negative total (credit).
- Tax allocates to the same shares, and every row's `taxBreakdown` components sum
  to that row's `taxAmountCents`.
- Breakdown amounts are decimal strings, not `BigInt` or numbers.
- A re-split divides net remaining, not face value.
- `PAYMENT`, `REFUND` and existing `TRANSFER` rows are excluded.
- A 0% share writes no rows at all for that target.
- Every pair nets to zero property-wide, and the sum of all folios' balances after
  a split equals the source folio's balance before it — the invariant that
  actually matters.

Route-level tests in `services/folio/src/routes/folioSplit.test.js`, following
`folioVoid.test.js`'s in-memory Prisma double: each validation rejection, the
same-stay and OPEN guards, and that the whole thing is issued as one
`$transaction`.

Two that guard the design's central promises:

- **A dry run writes nothing** — no folio created, no transaction row — and
  returns the same per-payer totals that a real split then produces for identical
  input. If these can disagree, the preview is lying to the operator.
- **The void guard reports the right reason**: a charge with a `TRANSFER` reversal
  is refused as split/transferred, a charge with a genuine void reversal is still
  refused as already voided.
- **Every payer's folio is named**, the source folio's included — the failure mode
  being a split that leaves the largest share on a document that cannot say who
  it bills.

Print-model tests in the existing `folioPrintModel.test.js`:

- `footer.billTo` is the folio's `payerName` when set and the stay's guest when
  not, so no existing folio's document changes.
- `meta.guestName` stays the **stay's** guest even when `payerName` differs — the
  occupant and the payer are different facts and the document keeps both.
- The split note names the co-payers and their shares, and is derived from the
  folio's TRANSFER rows rather than stored, so renaming a payer after the split
  reprints correctly.
- A folio with no transfers prints a blank `Remark`, exactly as today.

Web: `npx eslint`, `npm run build`, and `node --test` over the touched lib globs
(there is no `npm test` in `web/`).

## Not in scope

- **Reversing a split.** No "unsplit" action. The manual `Move` control can walk
  individual lines back, and each transfer pair is visible on both folios.
- **Splitting across stays or onto a walk-in folio.** The same-stay guard stands.
- **Splitting by amount** (payer A pays exactly ₱2,000, B the rest) or **by charge
  category** (A pays room, B pays extras). Both are plausible next methods; neither
  was asked for, and the `method` field leaves room for them.
- **Linking a payer to a `guestId`.** `payerName` is a plain string: a co-payer is
  often a company or a non-guest, and forcing a guest record for one would make
  splitting harder than doing it by hand. New folios still copy the source's
  `guestId` so the stay linkage is intact.
- **Renaming a payer after the split.** No edit control is added for `payerName`
  in this change. The printed note derives names at print time, so the field is
  safe to make editable later without reworking anything here.

## Files

| File | Change |
|---|---|
| `services/folio/src/lib/split.js` | new — `allocate`, `planSplit` |
| `services/folio/src/lib/split.test.js` | new |
| `services/folio/src/prisma/schema.prisma` | `Folio.payerName String?` |
| `services/folio/src/prisma/migrations/…_folio_payer_name/` | new migration |
| `services/folio/src/lib/transfer.js` | optional payer labels on descriptions |
| `services/folio/src/lib/folioPrintModel.js` | `billTo` from `payerName`; split note in `Remark` |
| `services/folio/src/lib/folioPrintModel.test.js` | cases for both |
| `services/folio/src/routes/folio.routes.js` | new `POST /folios/:id/split`; type-aware void guard; pass `payerName` into the print model |
| `services/folio/src/routes/folioSplit.test.js` | new |
| `web/src/pages/Folios.jsx` | split dialog replaces the add-folio button |
| `web/src/styles.css` | dialog styling |

No PDF layout work: the `Bill To` and `Remark` lines are already rendered at
`folio.routes.js:1821-1825`, and `Remark` prints blank today.
