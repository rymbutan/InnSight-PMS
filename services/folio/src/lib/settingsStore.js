// Database-backed settings access. Kept apart from settings.js so the parsers
// and validators stay unit-testable without a Prisma client.
//
// Both readers fall back to defaults on ANY failure. A folio must still print
// when the settings table is unreachable; refusing to print a guest's bill
// because a tax rate could not be read is a worse outcome than printing it at
// the shipped defaults.

const prisma = require('./prisma');
const { DEFAULT_TAX_RATES, DEFAULT_COUNTRY, defaultRatesForCountry } = require('./policies');
const {
  TAX_COMPONENT_KEYS, taxRateKey, normalizeCountry, HOTEL_KEYS, HOTEL_DEFAULTS, parseTaxRates, parseHotel,
  PAYMENT_FEE_KEY, parsePaymentFeePercent,
} = require('./settings');

// The jurisdiction a real charge is taxed against when no country is asked
// for explicitly — see policies.js: the property's own country, not a
// guest's nationality.
async function getPropertyCountry() {
  try {
    const rows = await prisma.appSetting.findMany({ where: { key: HOTEL_KEYS.country } });
    return normalizeCountry(rows[0]?.value) || DEFAULT_COUNTRY;
  } catch (err) {
    console.error('[Folio] Could not read property country, using default:', err.message);
    return DEFAULT_COUNTRY;
  }
}

// `country` is optional: omitted, this returns the rates that actually apply
// to a real charge (the property's own jurisdiction). Passed explicitly, it
// returns that country's rates instead — for Settings to browse or edit a
// jurisdiction other than the one currently active, without touching it.
async function getTaxRates(country) {
  const c = normalizeCountry(country) || (await getPropertyCountry());
  try {
    const rows = await prisma.appSetting.findMany({
      where: { key: { in: TAX_COMPONENT_KEYS.map((component) => taxRateKey(c, component)) } },
    });
    return { ...parseTaxRates(c, rows), country: c };
  } catch (err) {
    console.error('[Folio] Could not read tax rates, using defaults:', err.message);
    return { ...(c === DEFAULT_COUNTRY ? DEFAULT_TAX_RATES : defaultRatesForCountry(c)), country: c };
  }
}

async function getHotel() {
  try {
    const rows = await prisma.appSetting.findMany({
      where: { key: { in: Object.values(HOTEL_KEYS) } },
    });
    return parseHotel(rows);
  } catch (err) {
    console.error('[Folio] Could not read hotel identity, using defaults:', err.message);
    return { ...HOTEL_DEFAULTS };
  }
}

// `country` is required here (unlike getTaxRates) — writing rates for the
// wrong jurisdiction by accident is the one mistake this must not allow
// silently defaulting past.
async function saveTaxRates(country, rates) {
  const c = normalizeCountry(country);
  if (!c) throw new Error('saveTaxRates requires a 2-letter country code.');
  for (const component of TAX_COMPONENT_KEYS) {
    const key = taxRateKey(c, component);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: String(rates[component]) },
      update: { value: String(rates[component]) },
    });
  }
  return { ...rates, country: c };
}

async function saveHotel(hotel) {
  for (const [field, key] of Object.entries(HOTEL_KEYS)) {
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: String(hotel[field] ?? '') },
      update: { value: String(hotel[field] ?? '') },
    });
  }
  return hotel;
}

// Falls back to 0 on ANY failure, same discipline as getTaxRates above: a
// folio must still accept a card payment when settings are unreachable, and
// charging NO fee is the safe direction to fail in, not inventing one.
async function getPaymentFeePercent() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: PAYMENT_FEE_KEY } });
    return parsePaymentFeePercent(row);
  } catch (err) {
    console.error('[Folio] Could not read payment processing fee, using default:', err.message);
    return 0;
  }
}

async function savePaymentFeePercent(feePercent) {
  await prisma.appSetting.upsert({
    where: { key: PAYMENT_FEE_KEY },
    create: { key: PAYMENT_FEE_KEY, value: String(feePercent) },
    update: { value: String(feePercent) },
  });
  return feePercent;
}

module.exports = {
  getTaxRates,
  getHotel,
  getPropertyCountry,
  saveTaxRates,
  saveHotel,
  getPaymentFeePercent,
  savePaymentFeePercent,
};
