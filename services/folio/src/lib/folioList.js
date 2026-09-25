// One row of the folio list.
//
// The balance uses classifyTransactions -- the same classifier the printed folio
// and the check-out guard use -- so the number in the list is the number on the
// bill, not a second subtly different sum.

const { classifyTransactions } = require('./folioSummary');

// `isSplit` is passed in rather than derived here: this file is PURE (no
// Prisma), and answering "does another folio on this stay exist" needs a
// database query — one batched groupBy for the whole page, done once by the
// route, never a query per row. See GET /api/folios.
function folioListRow(folio, codes, guestName, { isSplit = false } = {}) {
  const summary = classifyTransactions(folio.transactions || [], codes);
  return {
    id: folio.id,
    folioNumber: folio.folioNumber,
    status: folio.status,
    currency: folio.currency,
    stayId: folio.stayId ?? null,
    guestId: folio.guestId ?? null,
    // The folio's OWN payer (set by a split) wins over the stay's overall
    // guest — same priority Folios.jsx's detail header already uses. Without
    // this, a bill split into "Jeffrey Par" and "Andrei Sumilang" showed
    // "Jeffrey Par" on BOTH rows in this list: Folio.guestId links the
    // STAY's guest, not who this particular folio actually bills.
    // null, not '—': the row is data, and the dash is the frontend's choice.
    guestName: folio.payerName || guestName || null,
    // The RAW payer, separate from the display-preferred guestName above —
    // lets a caller tell "this row's name is a distinct split payer" apart
    // from "this row's name is the stay's own guest", which guestName alone
    // cannot (Folios.jsx's stayGuestName fallback needs exactly that
    // distinction: picking a split payer's name as "the stay's guest" would
    // be wrong).
    payerName: folio.payerName ?? null,
    // Whether this folio shares its stay with at least one sibling folio —
    // i.e. the stay's bill was split — vs. a folio that is the only one on
    // its stay. A folio with no stay at all (a WALKIN/HOUSE folio) can have
    // no sibling and is always SOLO.
    chargeType: isSplit ? 'SPLIT' : 'SOLO',
    // JSON cannot carry BigInt.
    balanceCents: summary.balanceCents.toString(),
    openedAt: folio.openedAt,
    // Night-audit sign-off (see POST /folios/:id/audit-approve). The list
    // previously left this out, so a screen showing many folios at once
    // (the auditor's own dashboard) had no way to tell an already-approved
    // folio from one still waiting, short of opening each one individually.
    auditApprovedAt: folio.auditApprovedAt ?? null,
    auditApprovedBy: folio.auditApprovedBy ?? null,
  };
}

module.exports = { folioListRow };
