// One row of the folio list.
//
// The balance uses classifyTransactions -- the same classifier the printed folio
// and the check-out guard use -- so the number in the list is the number on the
// bill, not a second subtly different sum.

const { classifyTransactions } = require('./folioSummary');

function folioListRow(folio, codes, guestName) {
  const summary = classifyTransactions(folio.transactions || [], codes);
  return {
    id: folio.id,
    folioNumber: folio.folioNumber,
    status: folio.status,
    currency: folio.currency,
    stayId: folio.stayId ?? null,
    guestId: folio.guestId ?? null,
    // null, not '—': the row is data, and the dash is the frontend's choice.
    guestName: guestName ?? null,
    // JSON cannot carry BigInt.
    balanceCents: summary.balanceCents.toString(),
    openedAt: folio.openedAt,
  };
}

module.exports = { folioListRow };
