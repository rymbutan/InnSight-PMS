// How many payers the split-bill dialog opens with, before the user names or
// counts anyone.
//
// Pulled out of SplitBillDialog.jsx as plain logic — not JSX — so it can run
// under `node --test` the same way calendarBars.js does; this repo has no
// component-rendering test harness in web/.

export const MIN_PAYERS = 2;
export const MAX_PAYERS = 8;

/**
 * @param {number|null|undefined} adults  the reservation's adult count. Not a
 *   number, or fewer than two, when the booking has no reservation to read
 *   (a walk-in folio) or is solo — a split still needs at least two payers.
 * @returns {number} clamped to [MIN_PAYERS, MAX_PAYERS]
 */
export function defaultPayerCount(adults) {
  const n = Number(adults);
  if (!Number.isFinite(n)) return MIN_PAYERS;
  return Math.max(MIN_PAYERS, Math.min(MAX_PAYERS, Math.floor(n)));
}
