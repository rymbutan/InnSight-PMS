const { centsToWords } = require('./receiptWords');

// The data behind a payment receipt, separated from its rendering so the numbers
// can be unit-tested without producing a PDF.
//
// THIS IS NOT THE FOLIO BILL. /api/folios/:id/print already renders the guest's
// folio — everything charged, what is still owed. A receipt answers a different
// question: proof that ONE specific payment was received, which is what a guest
// asks for after handing over a deposit at reservation time, and what a company
// needs to reimburse an employee.
//
// The receipt number is derived from the folio number and the payment id rather
// than drawn from a counter. A real Philippine hotel needs a gapless BIR-registered
// official-receipt series, and minting a fake one here would teach students that a
// number they can regenerate is an official receipt. Deriving it also means
// reprinting is free: the same payment always prints the same number instead of
// consuming a new one.
function receiptModel(payment, folio, guestName) {
  if (payment.status === 'VOIDED') throw new Error('A voided payment has no receipt.');
  if (payment.status === 'FAILED') throw new Error('This payment has not been captured.');

  const paidCents = BigInt(payment.amountCents);

  return {
    receiptNumber: `OR-${folio.folioNumber}-${String(payment.id).slice(-12)}`,
    folioNumber: folio.folioNumber,
    currency: folio.currency || 'PHP',
    paidCents,
    paidInWords: centsToWords(paidCents),
    method: payment.method,
    paidAt: payment.createdAt,
    guestName: guestName || '—',
    // A refunded payment still gets a receipt — it happened, and the guest may need
    // to show what they paid — but the document has to say so, or it reads as proof
    // of money the hotel no longer holds.
    refunded: payment.status === 'REFUNDED',
    // Gateway/bank metadata captured when this payment was taken — printed as
    // proof of what was verified, not just that something was paid. Only
    // populated for the method it actually applies to; renderReceiptPdf skips
    // whichever block has nothing to show.
    gatewayRef: payment.gatewayRef || null,
    card:
      payment.method === 'CARD'
        ? { masked: payment.cardMasked || null, cardholderName: payment.cardholderName || null }
        : null,
    bankTransfer:
      payment.method === 'BANK_TRANSFER'
        ? {
            bankName: payment.bankName || null,
            transferNetwork: payment.transferNetwork || null,
            senderName: payment.senderName || null,
            transferredAt: payment.transferredAt || null,
          }
        : null,
  };
}

module.exports = { receiptModel };
