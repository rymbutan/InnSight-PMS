// Client-side mirror of services/reservation/src/lib/policies.js's
// cancellationFeeCents — used only to PRE-FILL the cancel modal's fee field
// with a terms-based suggestion. The server is what actually computes and
// applies the fee when no explicit override is sent; staff can still edit
// this suggestion before confirming (e.g. for the Terms & Conditions' own
// Force Majeure/PAGASA carve-out, which requires human judgment this
// function can't detect).
export function suggestedCancellationFeeCents({
  totalEstimateCents,
  checkIn,
  now = new Date(),
  method = null,
  isNonRefundable = false,
} = {}) {
  const total = Number(totalEstimateCents || 0);
  if (isNonRefundable) return total;
  const hours = (new Date(checkIn).getTime() - new Date(now).getTime()) / 36e5;
  if (hours >= 72) {
    const FLAT_ADMIN_FEE_CENTS = 20000; // PHP 200
    return method === 'CASH' ? FLAT_ADMIN_FEE_CENTS : Math.round(total * 0.03);
  }
  if (hours >= 24) return Math.round(total * 0.5);
  return total;
}
