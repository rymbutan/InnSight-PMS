// Money helpers: convert between pesos (user-facing) and cents (API-facing).

export function pesosToCents(pesos) {
  const n = typeof pesos === 'string' ? parseFloat(pesos) : Number(pesos);
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function centsToPesos(cents) {
  const n = typeof cents === 'string' ? Number(cents) : Number(cents || 0);
  return n / 100;
}

export function formatPeso(cents, { currency = 'PHP', sign = false } = {}) {
  const n = centsToPesos(cents);
  const abs = Math.abs(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const neg = n < 0 ? '-' : sign && n > 0 ? '+' : '';
  const symbol = currency === 'PHP' ? '₱' : `${currency} `;
  return `${neg}${symbol}${abs}`;
}

/** Whole cents after taking `percentOff` off, rounded the way the servers round
 *  (Math.round of cents * (1 - pct/100)) so a previewed total matches the saved one. */
export function afterPromoCents(cents, percentOff) {
  const pct = Number(percentOff) || 0;
  return Math.round(Number(cents || 0) * (1 - pct / 100));
}
