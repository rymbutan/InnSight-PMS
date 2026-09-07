// Splitting one folio's charges across several payers — the arithmetic half of
// bill splitting, kept pure so the maths that decides what a guest is billed can
// be tested without a database.
//
// This is the proportional counterpart to lib/transfer.js. `transfer` moves ONE
// WHOLE transaction to another folio; this divides every charge on a folio by a
// share vector, which is what the front desk means by "split it 60/40" or "split
// it three ways". It emits the same reversing TRANSFER pairs transfer.js does,
// for the same reason: a folio that silently loses a line it once carried is not
// an auditable bill, and the guest may already be holding a printed copy of it.
//
// WHY LARGEST REMAINDER, AND NOT NAIVE ROUNDING
// ---------------------------------------------
// A third of ₱1,000.00 is not a whole number of cents. Rounding each share
// independently gives 333.33 x 3 = ₱999.99, and the missing centavo is money
// destroyed — it makes two printed folios that do not add back up to the bill
// they came from. Largest remainder floors every share and then hands the
// leftover cents out one at a time, so the parts always sum to the total exactly.
//
// Ties break toward the earliest share so the result is deterministic: the same
// split run twice must produce identical folios, or a dry-run preview cannot be
// trusted to predict what the real split will write.

const { planTransfer } = require('./transfer');

// Shares arrive as percentages that may have decimals (33.33). Scaling by 10^4
// and rounding to an integer lets the whole allocation run in BigInt without
// ever putting money through a float. 4 places is well past the 2 the UI allows.
const SHARE_SCALE = 10000;

function toScaledShares(shares) {
  if (!Array.isArray(shares) || shares.length === 0) {
    throw new Error('A split needs at least one share.');
  }
  const scaled = shares.map((s) => {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error('A share must be a finite number.');
    if (n < 0) throw new Error('A share cannot be negative.');
    return BigInt(Math.round(n * SHARE_SCALE));
  });
  const total = scaled.reduce((a, b) => a + b, 0n);
  if (total === 0n) throw new Error('Shares cannot all be zero.');
  return { scaled, total };
}

/**
 * Divide an amount in cents by a share vector, exactly.
 *
 * @param {bigint|string|number} totalCents  may be negative — a credit line
 *   splits as legitimately as a charge
 * @param {number[]} shares  relative weights; [60, 40] and [6, 4] are the same
 *   split, so callers may pass percentages or plain ratios
 * @returns {bigint[]} one part per share, guaranteed to sum to totalCents
 */
function allocate(totalCents, shares) {
  const total = BigInt(totalCents);
  const { scaled, total: shareTotal } = toScaledShares(shares);

  // Work on the magnitude and re-apply the sign at the end. Truncating division
  // rounds toward zero, so on a negative total the "floor" step would round the
  // wrong way and the remainder loop would then push parts further apart.
  const negative = total < 0n;
  const magnitude = negative ? -total : total;

  const parts = [];
  const remainders = [];
  let distributed = 0n;
  for (let i = 0; i < scaled.length; i++) {
    const exact = magnitude * scaled[i];
    const whole = exact / shareTotal;
    parts.push(whole);
    remainders.push({ i, rem: exact - whole * shareTotal });
    distributed += whole;
  }

  // Hand the leftover cents to the largest fractional parts. Sorting by
  // remainder descending, then by index ascending, is what makes ties break
  // toward the earliest share.
  let leftover = magnitude - distributed;
  remainders.sort((a, b) => (b.rem === a.rem ? a.i - b.i : b.rem > a.rem ? 1 : -1));
  for (let k = 0; leftover > 0n; k++, leftover--) {
    parts[remainders[k % remainders.length].i] += 1n;
  }

  return negative ? parts.map((p) => -p) : parts;
}

/**
 * What is left of a transaction after any splits already made against it.
 *
 * A split does not consume the charge it divides; it posts negative TRANSFER
 * rows beside it. So after a 60/40 split the source folio still shows the full
 * ₱5,600 room charge with a -₱2,240 transfer next to it, and a SECOND split has
 * to divide ₱3,360 — the part still on this folio. Dividing the face value again
 * would move money that is no longer here and leave every folio wrong.
 *
 * planTransfer stamps `reversalOf` on both halves of a pair, so the link back to
 * the charge is already recorded and nothing new is needed to find it.
 *
 * @param {object} tx  the transaction being considered
 * @param {object[]} all  every transaction on the same folio
 */
function netRemaining(tx, all) {
  let amountCents = BigInt(tx.amountCents);
  let taxAmountCents = BigInt(tx.taxAmountCents || 0);
  for (const row of all) {
    if (row.id === tx.id) continue;
    if (row.type !== 'TRANSFER' || row.reversalOf !== tx.id) continue;
    amountCents += BigInt(row.amountCents);
    taxAmountCents += BigInt(row.taxAmountCents || 0);
  }
  return { amountCents, taxAmountCents };
}

// Only charges and adjustments divide.
//
// A PAYMENT or REFUND is money already taken from a named payer: moving it would
// say someone paid who did not. A TRANSFER is already the result of a split, and
// its effect is folded into its source line's net remaining, so splitting it
// again would double-count. The transfer route refuses all three for the same
// reasons, and a split must not become a way around that guard.
function isSplittable(tx) {
  return tx.type !== 'PAYMENT' && tx.type !== 'REFUND' && tx.type !== 'TRANSFER';
}

// Divide a tax breakdown by the same shares as the charge it belongs to.
//
// Each component is allocated separately, then the row's own components are
// reconciled against the row's tax so they sum to it exactly. Both levels
// matter: without the first the components drift from the shares, and without
// the second the printed folio's tax section disagrees with its own balance —
// which taxByComponent then hides by dumping the difference on VAT.
function splitBreakdown(breakdown, shares, index, rowTaxCents) {
  if (!Array.isArray(breakdown) || breakdown.length === 0) return null;

  const rows = breakdown.map((component) => {
    const parts = allocate(BigInt(component.amountCents || 0), shares);
    return { ...component, amountCents: parts[index] };
  });

  // Put any drift on the largest component rather than letting the row's parts
  // fail to account for its tax.
  const sum = rows.reduce((a, r) => a + r.amountCents, 0n);
  if (sum !== rowTaxCents && rows.length) {
    let biggest = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i].amountCents < 0n ? -rows[i].amountCents : rows[i].amountCents;
      const b = rows[biggest].amountCents < 0n ? -rows[biggest].amountCents : rows[biggest].amountCents;
      if (a > b) biggest = i;
    }
    rows[biggest].amountCents += rowTaxCents - sum;
  }

  // Stored as decimal STRINGS: BigInt has no JSON representation.
  return rows.map((r) => ({ ...r, amountCents: r.amountCents.toString() }));
}

/**
 * Every transaction row a split should write.
 *
 * The source folio keeps its share by NOT moving it — there is no self-transfer,
 * because a zero-value pair on one folio is two meaningless lines on a printed
 * document. Only the other payers' shares move, one reversing pair each.
 *
 * @param {object[]} args.transactions  every transaction on the source folio
 * @param {{folioId: string, share: number}[]} args.targets  the source folio
 *   MUST appear here, holding its own share
 * @param {Record<string,string>} args.folioNumbers  folioId -> folio number
 * @param {Record<string,string>} [args.payerNames]  folioId -> payer name, so a
 *   moved line names a person rather than only a document number
 * @returns {object[]} rows ready for prisma.folioTransaction.create
 */
function planSplit({ transactions = [], targets = [], folioNumbers = {}, payerNames = {}, sourceFolioId }) {
  if (targets.length < 2) throw new Error('A split needs at least two payers.');
  const sourceIndex = targets.findIndex((t) => t.folioId === sourceFolioId);
  if (sourceIndex === -1) {
    throw new Error('The source folio must be one of the payers, holding its own share.');
  }

  const shares = targets.map((t) => t.share);
  const labels = {};
  for (const [folioId, number] of Object.entries(folioNumbers)) {
    labels[folioId] = payerNames[folioId] ? `${number} (${payerNames[folioId]})` : number;
  }

  const rows = [];
  for (const tx of transactions) {
    if (!isSplittable(tx)) continue;

    const net = netRemaining(tx, transactions);
    if (net.amountCents === 0n && net.taxAmountCents === 0n) continue;

    const amountParts = allocate(net.amountCents, shares);
    const taxParts = allocate(net.taxAmountCents, shares);

    for (let i = 0; i < targets.length; i++) {
      if (i === sourceIndex) continue; // stays put
      const amountCents = amountParts[i];
      const taxAmountCents = taxParts[i];
      // A share that rounds away on this line gets no row for it. The payer may
      // still owe on other lines; this one simply did not divide their way.
      if (amountCents === 0n && taxAmountCents === 0n) continue;

      const [out, into] = planTransfer(
        { ...tx, amountCents, taxAmountCents },
        {
          fromFolioId: sourceFolioId,
          toFolioId: targets[i].folioId,
          folioNumbers: labels,
        }
      );
      // planTransfer leaves taxBreakdown alone, and the print model's fallback
      // cannot reach the originating charge from a RECEIVING folio — it lives on
      // another folio, so the lookup misses and the whole transferred tax prints
      // as VAT. Carrying an explicit, proportionally scaled breakdown on both
      // halves is what keeps the components intact on both documents.
      // Computed ONCE, for the receiving half, and negated for the source half.
      //
      // Doing it independently for each half is wrong in a way that sums
      // correctly and so hides: the components are allocated from the original's
      // POSITIVE figures, and reconciling that positive sum against the source
      // half's negative tax dumps the whole difference on one component. A 3-way
      // split of 220.00 tax printed the source's share as "vat -106.66 /
      // service charge +33.33" — the right total, an invented composition, and a
      // positive service charge on a line that gives money away.
      //
      // Negating a single allocation also guarantees the pair is symmetric per
      // component, which is what makes the two documents reconcile against each
      // other. The void route negates the original's breakdown for the same
      // reason.
      const receiving = splitBreakdown(tx.taxBreakdown, shares, i, into.taxAmountCents);
      into.taxBreakdown = receiving;
      out.taxBreakdown = receiving
        ? receiving.map((c) => ({ ...c, amountCents: (-BigInt(c.amountCents)).toString() }))
        : null;
      rows.push(out, into);
    }
  }
  return rows;
}

/**
 * The sentence a split folio prints on its Remark line.
 *
 * Derived from the folio's own transfer rows at print time rather than stored as
 * frozen prose, so it cannot drift from the transactions it describes and a payer
 * renamed later prints correctly.
 *
 * Returns '' when this folio was never part of a split — Remark prints blank
 * today and must keep doing so on an ordinary folio.
 *
 * @param {object[]} args.transactions  this folio's transactions
 * @param {{folioId, folioNumber, payerName}[]} args.counterparts  the other
 *   folios on the stay
 */
function splitNote({ transactions = [], counterparts = [] }) {
  const hasTransfers = transactions.some((t) => t.type === 'TRANSFER');
  if (!hasTransfers || counterparts.length === 0) return '';

  // Once each, in the order given — a folio's charges may have been divided
  // across many lines, and naming a co-payer once per line would be unreadable.
  const named = counterparts.map((c) =>
    c.payerName ? `${c.payerName} (folio ${c.folioNumber})` : `folio ${c.folioNumber}`
  );
  return `Split bill — shared with ${named.join(', ')}.`;
}

module.exports = { allocate, netRemaining, planSplit, splitNote };
