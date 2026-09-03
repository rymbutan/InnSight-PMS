// Spell out a peso amount for the "Amount in Words" line on a printed guest
// folio, matching the wording convention hotel folio templates use (e.g.
// "THIRTY-FIVE THOUSAND TWENTY-NINE AND FIFTY" for ₱35,029.50).
const ONES = [
  'ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
  'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
];
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];
const SCALES = ['', 'THOUSAND', 'MILLION', 'BILLION'];

function threeDigitsToWords(n) {
  const parts = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} HUNDRED`);
    n %= 100;
  }
  if (n >= 20) {
    const tens = TENS[Math.floor(n / 10)];
    const ones = n % 10;
    parts.push(ones ? `${tens}-${ONES[ones]}` : tens);
  } else if (n > 0) {
    parts.push(ONES[n]);
  }
  return parts.join(' ');
}

function integerToWords(n) {
  if (n === 0) return 'ZERO';
  const groups = [];
  let rest = n;
  let scaleIdx = 0;
  while (rest > 0) {
    const chunk = rest % 1000;
    if (chunk > 0) {
      const scale = SCALES[scaleIdx];
      groups.unshift(scale ? `${threeDigitsToWords(chunk)} ${scale}` : threeDigitsToWords(chunk));
    }
    rest = Math.floor(rest / 1000);
    scaleIdx += 1;
  }
  return groups.join(' ');
}

// amountCents may be a Number or a BigInt (Prisma returns BigInt for
// amountCents columns). Number() safely widens it — no hotel folio approaches
// Number.MAX_SAFE_INTEGER.
function centsToWords(amountCents) {
  const totalCents = Math.round(Number(amountCents));
  const sign = totalCents < 0 ? '-' : '';
  const abs = Math.abs(totalCents);
  const pesos = Math.floor(abs / 100);
  const centavos = abs % 100;
  const centavosWords = centavos > 0 ? ` AND ${threeDigitsToWords(centavos)}` : ' ONLY';
  return `${sign}${integerToWords(pesos)}${centavosWords}`;
}

module.exports = { centsToWords };
