// Pure helper: given raw staff-entered add-on lines and the CURRENT admin fee
// percentage, compute the frozen totals persisted onto the reservation. Frozen
// at creation time so a later change to the fee percentage never rewrites an
// already-booked guest's total (Changes-to-be-made doc, item 4).
function computeAddOns(rawAddOns, feePercent) {
  if (!Array.isArray(rawAddOns)) return [];
  const pct = Number(feePercent) || 0;
  return rawAddOns
    .filter((a) => a && typeof a.description === 'string' && a.description.trim())
    .map((a) => {
      const costCents = Math.max(0, Math.round(Number(a.costCents) || 0));
      const totalCents = Math.round(costCents * (1 + pct / 100));
      return {
        description: a.description.trim(),
        costCents,
        feePercent: pct,
        totalCents,
      };
    });
}

module.exports = { computeAddOns };
