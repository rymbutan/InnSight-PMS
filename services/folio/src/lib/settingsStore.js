// Database-backed settings access. Kept apart from settings.js so the parsers
// and validators stay unit-testable without a Prisma client.
//
// Both readers fall back to defaults on ANY failure. A folio must still print
// when the settings table is unreachable; refusing to print a guest's bill
// because a tax rate could not be read is a worse outcome than printing it at
// the shipped defaults.

const prisma = require('./prisma');
const { DEFAULT_TAX_RATES } = require('./policies');
const {
  TAX_RATE_KEYS, HOTEL_KEYS, HOTEL_DEFAULTS, parseTaxRates, parseHotel,
} = require('./settings');

async function getTaxRates() {
  try {
    const rows = await prisma.appSetting.findMany({
      where: { key: { in: Object.values(TAX_RATE_KEYS) } },
    });
    return parseTaxRates(rows);
  } catch (err) {
    console.error('[Folio] Could not read tax rates, using defaults:', err.message);
    return { ...DEFAULT_TAX_RATES };
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

async function saveTaxRates(rates) {
  for (const [component, key] of Object.entries(TAX_RATE_KEYS)) {
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: String(rates[component]) },
      update: { value: String(rates[component]) },
    });
  }
  return rates;
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

module.exports = { getTaxRates, getHotel, saveTaxRates, saveHotel };
