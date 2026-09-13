// Is a folio's night-audit sign-off still valid?
//
// Approval is a TIMESTAMP, not a flag, and that is the whole point. An auditor
// approves a bill as it stood at a moment; if anything is posted to the folio
// afterwards — a late minibar charge, a payment reversal, a refund — then what
// they signed off on is not what the guest is about to be charged, and the
// approval no longer means anything.
//
// Deriving staleness by comparison rather than clearing a boolean is what makes
// that safe: there is no charge, payment, void, adjustment or refund path that
// has to remember to reset it, so no future one can forget to.
//
// Exported as its own plain module so `node --test` can cover it — folio.routes
// imports Prisma and cannot be loaded by the test runner.

/** The latest instant anything was posted to this folio, or null if empty. */
function lastActivityAt(transactions = []) {
  let latest = null;
  for (const t of transactions) {
    const at = t.postedAt instanceof Date ? t.postedAt : new Date(t.postedAt);
    if (Number.isNaN(at.getTime())) continue;
    if (!latest || at > latest) latest = at;
  }
  return latest;
}

/**
 * @returns {{approved: boolean, stale: boolean, approvedAt: Date|null, approvedBy: string|null}}
 *   `stale` is true only when an approval EXISTS but has been overtaken by later
 *   activity — the desk needs to tell those two apart, because "nobody has
 *   checked this yet" and "this was checked, then the bill changed" are different
 *   things to say to a guest standing at the counter.
 */
function auditApprovalOf(folio, transactions = []) {
  const approvedAt = folio?.auditApprovedAt
    ? folio.auditApprovedAt instanceof Date
      ? folio.auditApprovedAt
      : new Date(folio.auditApprovedAt)
    : null;
  if (!approvedAt || Number.isNaN(approvedAt.getTime())) {
    return { approved: false, stale: false, approvedAt: null, approvedBy: null };
  }
  const last = lastActivityAt(transactions);
  // `>=`, so a tie invalidates. A transaction stamped the same millisecond as
  // the approval cannot be PROVEN to have been on screen when the auditor
  // signed, and the two failure directions are not equal: a needless re-check
  // costs the auditor a click, while a wrongly-held approval lets an unchecked
  // charge out of the building.
  const stale = !!last && last >= approvedAt;
  return {
    approved: !stale,
    stale,
    approvedAt,
    approvedBy: folio.auditApprovedBy || null,
  };
}

module.exports = { auditApprovalOf, lastActivityAt };
