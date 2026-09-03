// Builds a per-piece laundry ticket: several garment lines charged as ONE folio
// transaction (Changes-to-be-made doc, item 2 — laundry is priced per piece,
// e.g. ₱200 a polo, not per load).
//
// Pure on purpose: the money and the guest-visible wording are the parts that
// must not drift, and this way they are testable without a database or HTTP.
function buildLaundryTicket(lines) {
  if (!Array.isArray(lines)) throw new Error('A laundry ticket needs at least one garment line.');

  const usable = [];
  for (const line of lines) {
    const qty = Number(line?.qty ?? 0);
    // A fractional or negative count is a caller bug, not an empty line — say so
    // rather than silently dropping it and undercharging the guest.
    if (!Number.isInteger(qty) || qty < 0) {
      throw new Error('Each garment quantity must be a whole number of pieces, zero or more.');
    }
    if (qty === 0) continue;
    usable.push({ name: line.name, priceCents: Number(line.priceCents), qty });
  }

  if (usable.length === 0) throw new Error('A laundry ticket needs at least one garment line.');

  const totalCents = usable.reduce((sum, l) => sum + l.priceCents * l.qty, 0);
  const description = `Laundry: ${usable.map((l) => `${l.qty}× ${l.name}`).join(', ')}`;
  return { totalCents, description };
}

module.exports = { buildLaundryTicket };
