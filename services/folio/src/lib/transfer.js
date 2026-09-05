// Moving a charge between two folios of the same stay — the arithmetic half of
// bill splitting, kept pure so it can be tested without a database.
//
// WHY A REVERSING PAIR RATHER THAN REASSIGNING folioId
// ----------------------------------------------------
// The obvious implementation is to update the transaction's folioId and be done.
// It is wrong for a property management system: a folio that silently loses a line
// it once carried is not an auditable bill, and the guest may already be holding a
// printed copy of it. Posting a matched pair — a negative on the source, a positive
// on the destination, both naming the other folio — is what a real PMS prints, and
// it means the two documents still reconcile against each other afterwards.
//
// The charge code travels with the money. A minibar charge moved onto a company
// folio is still F&B revenue; dropping the code would quietly reclassify it in
// every report that keys off ChargeCode.category, including the night audit.
function planTransfer(tx, { fromFolioId, toFolioId, folioNumbers }) {
  if (fromFolioId === toFolioId) throw new Error('Cannot transfer to the same folio.');

  // Amounts arrive as BigInt from Prisma but as strings over JSON; coerce both so a
  // string never gets concatenated into a nonsense amount.
  const amount = BigInt(tx.amountCents);
  const tax = BigInt(tx.taxAmountCents || 0);

  const base = {
    type: 'TRANSFER',
    chargeCode: tx.chargeCode,
    quantity: tx.quantity || 1,
    reversalOf: tx.id,
  };

  return [
    {
      ...base,
      folioId: fromFolioId,
      description: `${tx.description} — transferred to folio ${folioNumbers[toFolioId]}`,
      amountCents: -amount,
      taxAmountCents: -tax,
    },
    {
      ...base,
      folioId: toFolioId,
      description: `${tx.description} — transferred from folio ${folioNumbers[fromFolioId]}`,
      amountCents: amount,
      taxAmountCents: tax,
    },
  ];
}

module.exports = { planTransfer };
