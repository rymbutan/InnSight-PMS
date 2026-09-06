// Folio-service settings: tax rates and the hotel identity block printed at the
// top of a guest folio.
//
// WHY THESE LIVE IN THE FOLIO SERVICE
// -----------------------------------
// The reservation service already has an AppSetting table, but posting a charge
// is a hot write path. Making every charge depend on the reservation service
// being reachable would trade a formatting improvement for an availability
// regression, so the folio service keeps its own copy.
//
// NOTE this requires a gateway change: `location /api/settings` proxies
// everything under that prefix to the reservation service, so these routes are
// only reachable via the longer-prefix locations added to nginx.conf.

// PURE — no Prisma, no I/O. Everything that touches the database lives in
// settingsStore.js. lib/prisma.js constructs a PrismaClient at module load, so
// requiring it here would make this file's unit tests need a database.

const { DEFAULT_TAX_RATES } = require('./policies');

// Component key → AppSetting key.
const TAX_RATE_KEYS = {
  vat: 'tax_vat_percent',
  serviceCharge: 'tax_service_charge_percent',
  localTax: 'tax_local_percent',
  realPropertyTax: 'tax_rpt_percent',
};

const HOTEL_KEYS = {
  name: 'hotel_name',
  address: 'hotel_address',
  phone: 'hotel_phone',
  fax: 'hotel_fax',
  email: 'hotel_email',
  url: 'hotel_url',
};

// Deliberately generic. The reference invoice belongs to a real hotel, and
// shipping its name, phone and e-mail as defaults would make every folio this
// system prints impersonate that business.
const HOTEL_DEFAULTS = {
  name: 'InnSight PMS',
  address: '',
  phone: '',
  fax: '',
  email: '',
  url: '',
};

function parseTaxRates(rows = []) {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const rates = { ...DEFAULT_TAX_RATES };
  for (const [component, key] of Object.entries(TAX_RATE_KEYS)) {
    if (!byKey.has(key)) continue;
    const n = Number(byKey.get(key));
    // A corrupt stored value must NOT become NaN tax on a guest's bill.
    if (Number.isFinite(n) && n >= 0 && n <= 100) rates[component] = n;
  }
  return rates;
}

function validateTaxRates(body = {}) {
  const unknown = Object.keys(body).filter((k) => !(k in TAX_RATE_KEYS));
  if (unknown.length) {
    // Rejected rather than ignored: silently dropping a field the caller
    // believed it set is how a rate ends up different from what the screen says.
    return { ok: false, error: `Unknown tax rate(s): ${unknown.join(', ')}.` };
  }
  const rates = { ...DEFAULT_TAX_RATES };
  for (const [component] of Object.entries(TAX_RATE_KEYS)) {
    if (!(component in body)) continue;
    const n = Number(body[component]);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return { ok: false, error: `${component} must be a number between 0 and 100.` };
    }
    rates[component] = n;
  }
  return { ok: true, rates };
}

function parseHotel(rows = []) {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const hotel = { ...HOTEL_DEFAULTS };
  for (const [field, key] of Object.entries(HOTEL_KEYS)) {
    if (byKey.has(key)) hotel[field] = String(byKey.get(key) ?? '');
  }
  return hotel;
}

function validateHotel(body = {}) {
  const unknown = Object.keys(body).filter((k) => !(k in HOTEL_KEYS));
  if (unknown.length) return { ok: false, error: `Unknown field(s): ${unknown.join(', ')}.` };
  const hotel = { ...HOTEL_DEFAULTS };
  for (const field of Object.keys(HOTEL_KEYS)) {
    if (!(field in body)) continue;
    const v = String(body[field] ?? '');
    if (v.length > 200) return { ok: false, error: `${field} must be 200 characters or fewer.` };
    hotel[field] = v;
  }
  return { ok: true, hotel };
}

module.exports = {
  TAX_RATE_KEYS,
  HOTEL_KEYS,
  HOTEL_DEFAULTS,
  parseTaxRates,
  validateTaxRates,
  parseHotel,
  validateHotel,
};
