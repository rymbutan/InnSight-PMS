// Per-method deposit detail — shared by NewReservation.jsx and WalkIn.jsx
// (a walk-in is a booking too, just one that skips the future-dated hold),
// and by Folios.jsx's own "Post payment" modal for the same shape.

export const CARD_BRANDS = ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER', 'JCB', 'OTHER'];

export const EMPTY_DEPOSIT_DETAIL = {
  cardBrand: 'VISA',
  cardLast4: '',
  cardholderName: '',
  gatewayRef: '',
  bankName: 'BDO',
  bankNameOther: '',
  transferNetwork: 'InstaPay',
  transferNetworkOther: '',
  senderName: '',
  bankRef: '',
  transferredAt: '',
};

// 'YYYY-MM-DDTHH:mm' in LOCAL time, what <input type="datetime-local"> both
// accepts and returns — toISOString() would shift this to UTC.
export function nowForDateTimeLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

// Mirrors services/reservation/src/lib/missingDepositField.js exactly, so a
// deposit either wizard lets through is never rejected by the server.
export function missingDepositField(method, detail) {
  if (method === 'CARD') {
    if (!/^\d{4}$/.test(detail.cardLast4)) return 'Enter the last 4 digits of the card.';
    if (!detail.cardholderName.trim()) return 'Cardholder name is required.';
  }
  if (method === 'BANK_TRANSFER') {
    if (detail.bankName === 'OTHER' && !detail.bankNameOther.trim()) return 'Enter the bank name.';
    if (detail.transferNetwork === 'OTHER' && !detail.transferNetworkOther.trim()) {
      return 'Enter the transfer network/channel.';
    }
    if (!detail.senderName.trim()) return "Sender/account holder's name is required.";
    if (!detail.bankRef.trim()) return 'Bank reference/control number is required.';
  }
  return null;
}
