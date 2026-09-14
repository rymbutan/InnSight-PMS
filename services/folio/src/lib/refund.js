// Posting a refund against a previous payment — pulled out of the
// POST /folios/:id/refund route so a PaymentDispute approval can post the
// exact same money movement instead of re-deriving it. Two independent copies
// of "how a refund is written" is precisely the kind of drift the folio
// bill-splitting design (docs/superpowers/specs/2026-09-08-folio-bill-splitting-design.md)
// warns about for tax math; the same risk applies here.
//
// Takes a Prisma client (or an interactive `$transaction` callback's `px`) so
// a caller that is already inside its own transaction — as dispute approval
// is — can pass that instead of opening a second one.

// A Payment and its ledger row are linked by FolioTransaction.reference ===
// Payment.id (see POST /folios/:id/payments). Dispute filing and dispute
// approval both need that row — filing so a case that could never be paid out
// is refused up front instead of dying at approval time, approval so it has
// something to refund against — so the lookup lives here rather than being
// written out twice with two chances to drift.
async function findPaymentTx(prisma, { folioId, paymentId }) {
  return prisma.folioTransaction.findFirst({
    where: { folioId, type: 'PAYMENT', reference: paymentId },
  });
}

// How much of an original payment has NOT yet been handed back. The cap below
// is enforced against this, and dispute filing quotes it so a claim cannot be
// filed for money that is already gone.
async function refundableCents(prisma, originalTx) {
  const priorRefunds = await prisma.folioTransaction.aggregate({
    where: { type: 'REFUND', refundOfId: originalTx.id },
    _sum: { amountCents: true },
  });
  const alreadyRefunded = priorRefunds._sum.amountCents || 0n;
  const remaining = originalTx.amountCents - alreadyRefunded;
  return { alreadyRefunded, remaining: remaining > 0n ? remaining : 0n };
}

async function postRefund(prisma, { folioId, originalTxId, amountCents, reason, postedBy }) {
  const original = await prisma.folioTransaction.findUnique({ where: { id: originalTxId } });
  if (!original) return { ok: false, status: 404, error: 'Original transaction not found.' };
  if (original.type !== 'PAYMENT') {
    return { ok: false, status: 400, error: 'Original must be a payment.' };
  }
  // Cap cumulative refunds at the original payment amount, not just this one.
  const { alreadyRefunded, remaining } = await refundableCents(prisma, original);
  if (amountCents > remaining) {
    return {
      ok: false,
      status: 400,
      error: 'Cumulative refunds cannot exceed the original payment amount.',
      alreadyRefundedCents: alreadyRefunded.toString(),
      originalAmountCents: original.amountCents.toString(),
      remainingRefundableCents: remaining.toString(),
    };
  }

  const refundTx = await prisma.folioTransaction.create({
    data: {
      folioId,
      type: 'REFUND',
      description: `Refund (${reason || 'no reason'})`,
      amountCents,
      paymentMethod: original.paymentMethod,
      refundOfId: originalTxId,
      refundReason: reason,
      postedBy,
    },
  });
  // Mark the original Payment row REFUNDED if a matching one exists. This
  // keeps reports consistent — un-reconciled refunds were a real bug.
  //
  // ONLY once the whole payment has gone back, though. Flipping the status on
  // the first partial refund said a ₱1,000 payment with ₱200 returned was
  // "REFUNDED": reports counted the other ₱800 as money the hotel no longer
  // held, and the folio screen dropped the Dispute/Refund actions on it, so
  // the remaining ₱800 could never be claimed against at all.
  if (original.reference && alreadyRefunded + amountCents >= original.amountCents) {
    await prisma.payment.updateMany({
      where: { id: original.reference, status: { in: ['AUTHORIZED', 'CAPTURED'] } },
      data: { status: 'REFUNDED' },
    });
  }
  return { ok: true, tx: refundTx };
}

module.exports = { postRefund, findPaymentTx, refundableCents };
