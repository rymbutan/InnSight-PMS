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

const { TAX_COMPONENTS, defaultRatesForCountry, DEFAULT_COUNTRY } = require('./policies');

const TAX_COMPONENT_KEYS = TAX_COMPONENTS.map((c) => c.key);

// Tax rates are now stored PER COUNTRY, not as one flat global set — this is
// the AppSetting key for one component of one jurisdiction's rate set. Any
// number of countries can have rates configured; which one is actually
// applied to a real charge is decided by the property's own country
// (HOTEL_KEYS.country below), not by whichever the operator looked at last.
function taxRateKey(country, component) {
  return `tax_${country}_${component}_percent`;
}

const COUNTRY_CODE = /^[A-Z]{2}$/;
function normalizeCountry(country) {
  const c = String(country ?? '').trim().toUpperCase();
  return COUNTRY_CODE.test(c) ? c : null;
}

const HOTEL_KEYS = {
  name: 'hotel_name',
  address: 'hotel_address',
  phone: 'hotel_phone',
  fax: 'hotel_fax',
  email: 'hotel_email',
  url: 'hotel_url',
  // The property's service times. Not cosmetic: the reservation service stamps
  // these onto checkIn/checkOut, and the no-double-booking constraint compares
  // tsrange(checkIn, checkOut), so these two values are what makes a same-day
  // turnover a clean handover instead of a conflict.
  checkInTime: 'hotel_checkin_time',
  checkOutTime: 'hotel_checkout_time',
  // ISO-3166 alpha-2. This is the jurisdiction a real charge's tax is computed
  // against — see policies.js's note on why the property's country governs,
  // not a guest's nationality.
  country: 'hotel_country',
};

// Fields that are a 24-hour HH:MM clock time rather than free text.
const HOTEL_TIME_FIELDS = ['checkInTime', 'checkOutTime'];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOfDay(hhmm) {
  const m = HHMM.exec(String(hhmm ?? ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

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
  // The near-universal hotel shape: rooms are vacated in the morning and
  // released again in the afternoon, leaving housekeeping the gap between.
  checkInTime: '14:00',
  checkOutTime: '12:00',
  country: DEFAULT_COUNTRY,
};

function parseTaxRates(country, rows = []) {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const rates = defaultRatesForCountry(country);
  for (const component of TAX_COMPONENT_KEYS) {
    const key = taxRateKey(country, component);
    if (!byKey.has(key)) continue;
    const n = Number(byKey.get(key));
    // A corrupt stored value must NOT become NaN tax on a guest's bill.
    if (Number.isFinite(n) && n >= 0 && n <= 100) rates[component] = n;
  }
  return rates;
}

function validateTaxRates(country, body = {}) {
  if (!normalizeCountry(country)) {
    return { ok: false, error: 'country must be a 2-letter ISO code, e.g. PH.' };
  }
  const unknown = Object.keys(body).filter((k) => !TAX_COMPONENT_KEYS.includes(k));
  if (unknown.length) {
    // Rejected rather than ignored: silently dropping a field the caller
    // believed it set is how a rate ends up different from what the screen says.
    return { ok: false, error: `Unknown tax rate(s): ${unknown.join(', ')}.` };
  }
  const rates = defaultRatesForCountry(country);
  for (const component of TAX_COMPONENT_KEYS) {
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
    if (HOTEL_TIME_FIELDS.includes(field)) {
      if (minutesOfDay(v) === null) {
        return { ok: false, error: `${field} must be a 24-hour time like 14:00.` };
      }
      hotel[field] = v;
      continue;
    }
    if (field === 'country') {
      const normalized = normalizeCountry(v);
      if (!normalized) return { ok: false, error: 'country must be a 2-letter ISO code, e.g. PH.' };
      hotel.country = normalized;
      continue;
    }
    if (v.length > 200) return { ok: false, error: `${field} must be 200 characters or fewer.` };
    hotel[field] = v;
  }

  // A stay runs from check-in on one day to check-out on a later one, so on the
  // clock the check-out must come FIRST. Equal or later would make a one-night
  // booking zero-length or negative, and the exclusion constraint would then
  // read every back-to-back pair in a room as an overlap.
  if (minutesOfDay(hotel.checkOutTime) >= minutesOfDay(hotel.checkInTime)) {
    return {
      ok: false,
      error: 'checkOutTime must be earlier in the day than checkInTime.',
    };
  }
  return { ok: true, hotel };
}

// A single global percentage surcharge for CARD/BANK_TRANSFER payments (see
// POST /folios/:id/payments and policies.js's paymentProcessingFeeCents).
// Defaults to 0 — a fresh install charges no fee until an operator sets one,
// same "nothing fabricated" discipline as localTax/realPropertyTax defaulting
// to zero in policies.js.
const PAYMENT_FEE_KEY = 'payment_processing_fee_percent';
const DEFAULT_PAYMENT_FEE_PERCENT = 0;

function parsePaymentFeePercent(row) {
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_PAYMENT_FEE_PERCENT;
}

function validatePaymentFeePercent(body = {}) {
  const n = Number(body.feePercent);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return { ok: false, error: 'feePercent must be a number between 0 and 100.' };
  }
  return { ok: true, feePercent: n };
}

module.exports = {
  TAX_COMPONENT_KEYS,
  taxRateKey,
  normalizeCountry,
  HOTEL_KEYS,
  HOTEL_DEFAULTS,
  HOTEL_TIME_FIELDS,
  minutesOfDay,
  parseTaxRates,
  validateTaxRates,
  parseHotel,
  validateHotel,
  PAYMENT_FEE_KEY,
  DEFAULT_PAYMENT_FEE_PERCENT,
  parsePaymentFeePercent,
  validatePaymentFeePercent,
};
