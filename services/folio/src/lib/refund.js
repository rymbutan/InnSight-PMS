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

async function postRefund(prisma, { folioId, originalTxId, amountCents, reason, postedBy }) {
  const original = await prisma.folioTransaction.findUnique({ where: { id: originalTxId } });
  if (!original) return { ok: false, status: 404, error: 'Original transaction not found.' };
  if (original.type !== 'PAYMENT') {
    return { ok: false, status: 400, error: 'Original must be a payment.' };
  }
  // Cap cumulative refunds at the original payment amount, not just this one.
  const priorRefunds = await prisma.folioTransaction.aggregate({
    where: { type: 'REFUND', refundOfId: originalTxId },
    _sum: { amountCents: true },
  });
  const alreadyRefunded = priorRefunds._sum.amountCents || 0n;
  if (alreadyRefunded + amountCents > original.amountCents) {
    return {
      ok: false,
      status: 400,
      error: 'Cumulative refunds cannot exceed the original payment amount.',
      alreadyRefundedCents: alreadyRefunded.toString(),
      originalAmountCents: original.amountCents.toString(),
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
  if (original.reference) {
    await prisma.payment.updateMany({
      where: { id: original.reference, status: { in: ['AUTHORIZED', 'CAPTURED'] } },
      data: { status: 'REFUNDED' },
    });
  }
  return { ok: true, tx: refundTx };
}

module.exports = { postRefund };
