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

const DASH = '—';

// Sum one component across a set of transactions, falling back to VAT for rows
// written before the taxBreakdown column existed.
//
// The fallback is what keeps historical folios printing the SAME total they
// always did: their whole taxAmountCents lands on VAT rather than being invented
// across four lines or dropped.
function taxByComponent(transactions) {
  const totals = Object.fromEntries(TAX_COMPONENTS.map((c) => [c.key, 0n]));
  for (const tx of transactions) {
    const tax = BigInt(tx.taxAmountCents || 0);
    if (tax === 0n) continue;
    const rows = Array.isArray(tx.taxBreakdown) ? tx.taxBreakdown : null;
    if (!rows || rows.length === 0) {
      totals.vat += tax;
      continue;
    }
    let attributed = 0n;
    for (const row of rows) {
      if (!(row.key in totals)) continue;
      const amt = BigInt(row.amountCents || 0);
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
  const tariffCents = summary.roomChargeCents / BigInt(nights || 1);

  const guestName = stay?.guestName || reservation?.guestName || DASH;

  // The reference shows Room Charges GROSS with a Less Discount line beneath,
  // netting to the subtotal. classifyTransactions already nets a negative room
  // charge into roomChargeCents, so the gross figure is recovered by adding the
  // discounts back — printing summary.roomChargeCents as "Room Charges" AND the
  // discounts again would deduct them twice.
  const roomDiscountCents = roomCharges
    .filter((t) => BigInt(t.amountCents) < 0n)
    .reduce((a, t) => a - BigInt(t.amountCents), 0n);
  const roomGrossCents = summary.roomChargeCents + roomDiscountCents;

  const sections = [
    {
      title: 'Room Charges',
      rows: [
        { label: 'Room Charges', amountCents: roomGrossCents },
        { label: 'Less Discount', amountCents: roomDiscountCents },
      ],
      // Gross minus discount — identical to what the classifier billed.
      subtotalCents: summary.roomChargeCents,
    },
    { title: 'Add : Room Tax', rows: roomTaxRows, subtotalCents: sumRows(roomTaxRows) },
    {
      title: 'Add : Extra Charges',
      rows: [
        {
          label: 'Extra Charges',
          amountCents: summary.extraChargeCents + summary.facilityChargeCents,
        },
      ],
      subtotalCents: summary.extraChargeCents + summary.facilityChargeCents,
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
      billTo: guestName,
      // Guest has no address field, and the reference's own Address line reads
      // only "Philippines". Nationality is the closest true fact this system holds.
      address: guest?.nationality || DASH,
      amountInWords: centsToWords(summary.balanceCents),
      remark: '',
    },
  };
}

module.exports = { folioPrintModel, taxByComponent };
