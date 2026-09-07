// The guest folio as a structured document, separated from its rendering so the
// arithmetic on a guest's bill can be unit-tested without producing a PDF.
//
// The layout follows the panel's reference invoice
// (10 - References/FELISMINO-JANA-MARIE_GUEST-FOLIO.pdf) section for section.
//
// EVERY SECTION IS ALWAYS PRESENT, even at zero. The reference is a fixed grid,
// and a form that grows and shrinks row by row stops being recognisable as the
// same document — staff read these by position.

const { TAX_COMPONENTS } = require('./policies');
const { centsToWords } = require('./receiptWords');
const { splitNote } = require('./split');

const DASH = '—';

// Sum one component across a set of transactions, falling back to VAT for rows
// written before the taxBreakdown column existed.
//
// The fallback is what keeps historical folios printing the SAME total they
// always did: their whole taxAmountCents lands on VAT rather than being invented
// across four lines or dropped.
//
// REVERSALS ARE MIRRORED, NOT FALLEN BACK ON
// ------------------------------------------
// A void writes a reversal row carrying -taxAmountCents. Reversals written
// before the void route started copying the breakdown carry NO taxBreakdown of
// their own, and the pre-migration fallback above would then dump that whole
// NEGATIVE figure on VAT — printing, for a voided 10,000.00 room night,
// "VAT -1,000.00" and "Service Charge +1,000.00" on a guest's bill. The
// subtotal is right either way, which is exactly why nothing caught it: the
// error nets to zero one level up.
//
// So a breakdown-less row that is a reversal borrows its ORIGINAL's breakdown
// and negates it. This repairs rows already in the database as well as new
// ones, and it degrades correctly when the original has no breakdown either
// (both fall back to VAT, and net to zero there, which is right).
function taxByComponent(transactions) {
  const totals = Object.fromEntries(TAX_COMPONENTS.map((c) => [c.key, 0n]));
  const byId = new Map(transactions.filter((t) => t.id).map((t) => [t.id, t]));
  for (const tx of transactions) {
    const tax = BigInt(tx.taxAmountCents || 0);
    if (tax === 0n) continue;
    let rows = Array.isArray(tx.taxBreakdown) ? tx.taxBreakdown : null;
    // -1 when the rows being read belong to the transaction this one reverses.
    let sign = 1n;
    if (!rows || rows.length === 0) {
      const original = tx.reversalOf ? byId.get(tx.reversalOf) : null;
      const originalRows = Array.isArray(original?.taxBreakdown) ? original.taxBreakdown : null;
      if (originalRows && originalRows.length > 0) {
        rows = originalRows;
        sign = -1n;
      }
    }
    if (!rows || rows.length === 0) {
      totals.vat += tax;
      continue;
    }
    let attributed = 0n;
    for (const row of rows) {
      if (!(row.key in totals)) continue;
      const amt = sign * BigInt(row.amountCents || 0);
      totals[row.key] += amt;
      attributed += amt;
    }
    // A breakdown that does not account for the whole tax would make the folio's
    // sections disagree with its balance. Put the remainder on VAT rather than
    // letting money vanish off the document.
    if (attributed !== tax) totals.vat += tax - attributed;
  }
  return totals;
}

function componentRows(totals) {
  return TAX_COMPONENTS.map((c) => ({ label: c.label, amountCents: totals[c.key] }));
}

function sumRows(rows) {
  return rows.reduce((a, r) => a + r.amountCents, 0n);
}

function fmtDate(d) {
  if (!d) return DASH;
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return DASH;
  // Reference format: M/D/YYYY.
  return `${x.getUTCMonth() + 1}/${x.getUTCDate()}/${x.getUTCFullYear()}`;
}

function fmtTime(d) {
  if (!d) return DASH;
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return DASH;
  return x.toISOString().slice(11, 19);
}

function folioPrintModel({
  folio,
  transactions = [],
  summary,
  guest = null,
  stay = null,
  reservation = null,
  hotel = {},
  // The other folios on this stay, for the split note. Empty on an unsplit
  // folio, which is why an ordinary document's Remark line stays blank.
  counterparts = [],
}) {
  const charges = transactions.filter((t) => t.type === 'CHARGE' || t.type === 'TRANSFER');
  const roomCharges = charges.filter((t) => t.__isRoom);
  const otherCharges = charges.filter((t) => !t.__isRoom);

  // classifyTransactions has already done the room/facility/extra split; reuse
  // its totals rather than re-deriving them, so the document can never disagree
  // with the balance the desk is blocked on.
  const roomTax = taxByComponent(roomCharges);
  const otherTax = taxByComponent(otherCharges);

  const transfersIn = transactions.filter((t) => t.type === 'TRANSFER' && BigInt(t.amountCents) > 0n);
  const transfersOut = transactions.filter((t) => t.type === 'TRANSFER' && BigInt(t.amountCents) < 0n);
  const discounts = transactions.filter(
    (t) => t.type === 'ADJUSTMENT' && BigInt(t.amountCents) < 0n
  );
  const otherAdjustments = transactions.filter(
    (t) => t.type === 'ADJUSTMENT' && BigInt(t.amountCents) >= 0n
  );

  const roomTaxRows = componentRows(roomTax);
  const chargeTaxRows = componentRows(otherTax);

  const discountRows = discounts.map((t) => ({
    label: t.description || 'Discount',
    amountCents: -BigInt(t.amountCents),
  }));
  const adjustmentRows = otherAdjustments.map((t) => ({
    label: t.description || 'Adjustment',
    amountCents: BigInt(t.amountCents),
  }));
  const transferInRows = transfersIn.map((t) => ({
    label: t.description || 'Folio Transferred',
    amountCents: BigInt(t.amountCents),
  }));
  const transferOutRows = transfersOut.map((t) => ({
    label: t.description || 'Folio Transferred',
    amountCents: -BigInt(t.amountCents),
  }));

  const nights = reservation?.nights || 1;
  const tariffCents = summary.roomChargeCents / BigInt(nights);

  const guestName = stay?.guestName || reservation?.guestName || DASH;

  // classifyTransactions folds TRANSFER into roomChargeCents / facilityChargeCents
  // / extraChargeCents exactly like CHARGE (see folioSummary.js) — a transferred
  // charge keeps its original chargeCode, so it is room- or non-room-tagged like
  // any other charge. But this document ALSO gives transfer principal its own
  // "Transferred From/To Folio" sections (the reference invoice has them, and the
  // panel asked for that layout). If the Room/Extra Charges sections kept using
  // summary.roomChargeCents / extraChargeCents+facilityChargeCents directly, a
  // transfer's principal would be printed twice: once folded into its charge
  // bucket, once again in its own section. So here it is backed OUT of the charge
  // buckets — each transfer's principal then appears in exactly one place.
  //
  // Tax is NOT adjusted this way: taxByComponent below still runs over the full
  // roomCharges/otherCharges (transfers included), because a transferred charge's
  // tax rides with it (see transfer.js) and has no section of its own — it must
  // stay wherever the charge's room/non-room split puts it, or Room Tax + Tax On
  // Charges would stop summing to the folio's real tax.
  const roomChargeOnly = roomCharges.filter((t) => t.type === 'CHARGE');
  const roomTransferCents = roomCharges
    .filter((t) => t.type === 'TRANSFER')
    .reduce((a, t) => a + BigInt(t.amountCents), 0n);
  const roomChargeCentsExclTransfers = summary.roomChargeCents - roomTransferCents;

  const otherTransferCents = otherCharges
    .filter((t) => t.type === 'TRANSFER')
    .reduce((a, t) => a + BigInt(t.amountCents), 0n);
  const extraChargeCentsExclTransfers =
    summary.extraChargeCents + summary.facilityChargeCents - otherTransferCents;

  // The reference shows Room Charges GROSS with a Less Discount line beneath,
  // netting to the subtotal. classifyTransactions already nets a negative room
  // charge into roomChargeCents, so the gross figure is recovered by adding the
  // discounts back — printing the net figure as "Room Charges" AND the discounts
  // again would deduct them twice. Discounts are read off CHARGE-type rows only
  // (roomChargeOnly), never TRANSFER: a transfer-out's negative amount belongs in
  // "Transferred To Folio", not "Less Discount".
  const roomDiscountCents = roomChargeOnly
    .filter((t) => BigInt(t.amountCents) < 0n)
    .reduce((a, t) => a - BigInt(t.amountCents), 0n);
  const roomGrossCents = roomChargeCentsExclTransfers + roomDiscountCents;

  const sections = [
    {
      title: 'Room Charges',
      rows: [
        { label: 'Room Charges', amountCents: roomGrossCents },
        { label: 'Less Discount', amountCents: roomDiscountCents },
      ],
      // Gross minus discount, transfer principal excluded (it is booked in its
      // own Transferred From/To sections instead). Equal to summary.roomChargeCents
      // only when no transfer is tagged room; classifyTransactions folds transfer
      // principal into that figure too, but this section must not repeat it.
      subtotalCents: roomChargeCentsExclTransfers,
    },
    { title: 'Add : Room Tax', rows: roomTaxRows, subtotalCents: sumRows(roomTaxRows) },
    {
      title: 'Add : Extra Charges',
      rows: [
        {
          label: 'Extra Charges',
          amountCents: extraChargeCentsExclTransfers,
        },
      ],
      subtotalCents: extraChargeCentsExclTransfers,
    },
    { title: 'Add : Tax On Charges', rows: chargeTaxRows, subtotalCents: sumRows(chargeTaxRows) },
    {
      title: 'Add : Transferred From Folio',
      rows: transferInRows.length ? transferInRows : [{ label: 'Folio Transferred', amountCents: 0n }],
      subtotalCents: sumRows(transferInRows),
    },
    {
      title: 'Less : Flat Discount',
      rows: discountRows.length ? discountRows : [{ label: 'Flat Discount', amountCents: 0n }],
      subtotalCents: sumRows(discountRows),
    },
    {
      title: 'Less : Amount Paid',
      rows: [{ label: 'Payment By Guest', amountCents: summary.netPaymentsCents }],
      subtotalCents: summary.netPaymentsCents,
    },
    {
      title: 'Less : Transferred To Folio',
      rows: transferOutRows.length ? transferOutRows : [{ label: 'Folio Transferred', amountCents: 0n }],
      subtotalCents: sumRows(transferOutRows),
    },
    {
      title: 'Adjustment',
      rows: adjustmentRows.length ? adjustmentRows : [{ label: 'Adjustment', amountCents: 0n }],
      subtotalCents: sumRows(adjustmentRows),
    },
  ];

  return {
    hotel: {
      name: hotel.name || 'InnSight PMS',
      address: hotel.address || '',
      phone: hotel.phone || '',
      fax: hotel.fax || '',
      email: hotel.email || '',
      url: hotel.url || '',
    },
    meta: {
      folioNumber: folio.folioNumber,
      date: fmtDate(new Date()),
      guestName,
      nationality: guest?.nationality || DASH,
      pax: reservation ? (reservation.adults || 0) + (reservation.children || 0) : DASH,
      adults: reservation?.adults ?? DASH,
      children: reservation?.children ?? DASH,
      // InnSight has no physical registration card; the confirmation number is
      // the identifier a guest is actually asked for.
      grCardNo: reservation?.confirmationNumber || DASH,
      arrival: fmtDate(stay?.actualCheckInAt || reservation?.checkIn),
      departure: fmtDate(stay?.actualCheckOutAt || reservation?.checkOut),
      arrivalTime: fmtTime(stay?.actualCheckInAt),
      tariffCents,
    },
    sections,
    totals: {
      totalChargesCents: summary.totalChargesCents,
      totalPaymentCents: summary.netPaymentsCents,
      balanceCents: summary.balanceCents,
    },
    footer: {
      currency: folio.currency || 'PHP',
      // Who this folio BILLS, which after a bill split is not always the guest
      // whose stay it is. Before payerName existed every folio on a stay printed
      // the same name here, so the two halves of a split were two documents both
      // claiming to bill the same person and differing only in their totals.
      //
      // meta.guestName above deliberately still names the guest: who occupied
      // the room and who settles this folio are separate facts and the document
      // carries a line for each.
      billTo: folio.payerName || guestName,
      // Guest has no address field, and the reference's own Address line reads
      // only "Philippines". Nationality is the closest true fact this system holds.
      address: guest?.nationality || DASH,
      amountInWords: centsToWords(summary.balanceCents),
      // Derived from this folio's own transfer rows at print time, not stored at
      // split time, so it cannot drift from the transactions it describes and a
      // payer renamed afterwards reprints correctly. '' on an unsplit folio.
      remark: splitNote({ transactions, counterparts }),
    },
  };
}

module.exports = { folioPrintModel, taxByComponent };
