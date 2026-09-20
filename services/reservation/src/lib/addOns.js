// Pure helper: given raw staff-entered add-on lines and the CURRENT admin fee
// percentage, compute the frozen totals persisted onto the reservation. Frozen
// at creation time so a later change to the fee percentage — or a later edit
// to the catalog price — never rewrites an already-booked guest's total
// (Changes-to-be-made doc, item 4).
//
// `catalogByCode` is the authoritative price list (AddOnCatalogItem rows,
// keyed by code). A line with a `code` that resolves in it is priced from the
// catalog, never from whatever costCents the client sent — the same
// never-trust-the-client-on-money discipline the promo-code and deposit-fee
// paths already follow. A line with no code (the wizard's free-text "Other")
// keeps the old staff-entered-cost behaviour, since there is no catalog price
// for a one-off request to look up.
function computeAddOns(rawAddOns, feePercent, catalogByCode = {}) {
  if (!Array.isArray(rawAddOns)) return [];
  const pct = Number(feePercent) || 0;
  return rawAddOns
    .filter((a) => a && typeof a.description === 'string' && a.description.trim())
    .map((a) => {
      const catalogItem = a.code ? catalogByCode[a.code] : null;
      const costCents = catalogItem
        ? Math.max(0, Math.round(Number(catalogItem.priceCents) || 0))
        : Math.max(0, Math.round(Number(a.costCents) || 0));
      const totalCents = Math.round(costCents * (1 + pct / 100));
      return {
        ...(catalogItem ? { code: catalogItem.code } : {}),
        description: catalogItem ? catalogItem.label : a.description.trim(),
        costCents,
        feePercent: pct,
        totalCents,
      };
    });
}

module.exports = { computeAddOns };
