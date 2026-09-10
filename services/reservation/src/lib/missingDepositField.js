// Per-method validation for the deposit collected in the New Reservation
// wizard's Payment step. Ported from services/folio/src/routes/folio.routes.js's
// missingPaymentField — same rules, same request-body shape (cardMasked,
// cardholderName, bankName, transferNetwork, senderName, gatewayRef/reference)
// — so a CARD or BANK_TRANSFER deposit is held to the same standard Folio
// already holds a folio payment to, before the booking even leaves the wizard.
//
// A bank transfer's reference is never simulated (unlike CARD's gatewayRef,
// which Folio fills with a fake AUTH-... if left blank): a bank reference this
// system cannot verify against a real control number would teach the wrong
// lesson about what "confirming" one means. Same reasoning as Folio's.
function missingDepositField(method, body) {
  if (method === 'CARD') {
    if (!body.cardMasked) return 'Card brand and last 4 digits are required.';
    if (!body.cardholderName || !String(body.cardholderName).trim()) {
      return 'Cardholder name is required for a card payment.';
    }
  }
  if (method === 'BANK_TRANSFER') {
    if (!body.bankName || !String(body.bankName).trim()) return 'Bank name is required.';
    if (!body.transferNetwork || !String(body.transferNetwork).trim()) {
      return 'Transfer network/channel is required.';
    }
    if (!body.senderName || !String(body.senderName).trim()) {
      return "Sender/account holder's name is required.";
    }
    if (!(body.gatewayRef || body.reference)) {
      return 'A bank reference/control number is required for a bank transfer.';
    }
  }
  return null;
}

module.exports = { missingDepositField };
