# Folio Formatting & Folio List — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Print a guest folio matching the reference invoice's tabulated layout with genuinely computed tax components, and replace the folio-ID box with a searchable folio list built on the guest-profile layout.

**Architecture:** Tax decomposition is a pure function fed by rates from a new folio-service `AppSetting` table; the per-component breakdown is persisted alongside the existing combined total, which stays the single source of truth for every balance. The printed folio is assembled by a pure `folioPrintModel()` so the arithmetic is testable without pdfkit. The Folios page adopts the search/browse/select pattern `Guests.jsx` already implements.

**Tech Stack:** Node 20, Express 4, Prisma 6, pdfkit 0.15, `node:test` + `node:assert`, React 18, nginx.

**Spec:** `docs/superpowers/specs/2026-09-05-folio-arrivals-room-editor-design.md` §1

**Reference document:** `10 - References/FELISMINO-JANA-MARIE_GUEST-FOLIO.pdf`

## Global Constraints

- **`taxAmountCents` remains the single source of truth for every total.** `classifyTransactions` (`services/folio/src/lib/folioSummary.js`), the daily-totals route, the outstanding-balance guard and the check-out block all keep reading it, and none of them change. `taxBreakdown` is presentation detail layered on top. **No existing folio's total, balance or printed figure may move by one centavo** — `folioSummary.test.js` is the regression gate.
- **Pre-migration rows have `taxBreakdown: null`** and must render with their whole `taxAmountCents` attributed to VAT. Never backfill historical financial records to improve a layout.
- **Do not hardcode "Aureliscita Grande Hotel", its address, phone, fax, e-mail or URL.** Those identify a real business; shipping them as defaults would make every printed folio impersonate it. Hotel identity is configurable and defaults to InnSight PMS.
- **Local Tax and Real Property Tax default to `0`.** The reference's implied 1.85% and 14.33% are property-specific, not standard rates. VAT defaults to `12` and Service Charge to `10` — the Philippine standards, which reproduce the reference exactly.
- Money is `BigInt` cents end to end. Never use floating-point arithmetic on amounts. ADR/RevPAR and every folio figure are stored in cents.
- `services/_shared/*.js` is vendored byte-identically into each service's `src/lib/`. Edit `_shared` first, copy to **all ten** services, and `bash scripts/check-shared.sh` must exit 0 (CI and pre-commit both run it).
- Tests are colocated `*.test.js` run by `node --test`, using `require('node:test')` and `require('node:assert')`.
- Prisma migrations: baselines exist since Phase 2, so `db-init.sh` runs `migrate deploy`. Create migrations with `prisma migrate dev --name <name>`; never `db push` against a migrated database.
- `services/gateway/nginx.conf` is **baked into the gateway image** — changes need `docker compose up -d --build gateway`, not a restart.
- Currency symbol in the UI is `₱` via `formatPeso` (`web/src/lib/money.js`). The printed PDF uses the reference's trailing-`P` convention.

---

### Task 1: Four configurable tax components

**Files:**
- Modify: `services/_shared/policies.js` (the tax engine section)
- Copy to: all ten `services/*/src/lib/policies.js`
- Test: `services/folio/src/lib/policies.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DEFAULT_TAX_RATES` = `{ vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 }` (percent numbers).
  - `TAX_COMPONENTS` = ordered array `[{ key, label }]` — `vat`/`VAT`, `serviceCharge`/`Service Charge`, `localTax`/`Local Tax`, `realPropertyTax`/`Real Property Tax`. Print order matches the reference.
  - `computeTax({ subtotalCents, category, rates })` → `{ taxCents: BigInt, breakdown: [{ key, label, rate, amountCents }] }` where `amountCents` values are `BigInt` and sum exactly to `taxCents`. Non-taxable categories return `{ taxCents: 0n, breakdown: [] }`.

  `computeTax` stays **pure** — rates are passed in, never read from a database inside it, so this test file needs no database.

- [ ] **Step 1: Write the failing tests**

Create `services/folio/src/lib/policies.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { computeTax, DEFAULT_TAX_RATES, TAX_COMPONENTS } = require('./policies');

// The reference invoice (FELISMINO-JANA-MARIE_GUEST-FOLIO.pdf): a room charge of
// 25,350.00 P produces 3,042.00 VAT and 2,535.00 service charge. If these two
// assertions ever fail, the printed folio no longer matches the document this
// layout was copied from.
const REFERENCE_ROOM_CENTS = 2535000n;

test('the default rates reproduce the reference invoice exactly', () => {
  const { taxCents, breakdown } = computeTax({
    subtotalCents: REFERENCE_ROOM_CENTS,
    category: 'ROOM',
    rates: DEFAULT_TAX_RATES,
  });
  const by = Object.fromEntries(breakdown.map((b) => [b.key, b.amountCents]));
  assert.equal(by.vat, 304200n, 'VAT at 12% of 25,350.00');
  assert.equal(by.serviceCharge, 253500n, 'service charge at 10% of 25,350.00');
  assert.equal(by.localTax, 0n, 'local tax is property-specific and defaults to 0');
  assert.equal(by.realPropertyTax, 0n, 'RPT is property-specific and defaults to 0');
  assert.equal(taxCents, 557700n);
});

// The invariant that keeps the breakdown from ever disagreeing with the total
// the balance is computed from.
test('the components always sum exactly to taxCents', () => {
  for (const subtotal of [0n, 1n, 7n, 333n, 99999n, 2535000n, 123456789n]) {
    const { taxCents, breakdown } = computeTax({
      subtotalCents: subtotal,
      category: 'ROOM',
      rates: { vat: 12, serviceCharge: 10, localTax: 1.85, realPropertyTax: 14.33 },
    });
    const summed = breakdown.reduce((a, b) => a + b.amountCents, 0n);
    assert.equal(summed, taxCents, `components must sum to the total for ${subtotal}`);
  }
});

test('every component is returned even at a zero rate, so the print has all four rows', () => {
  const { breakdown } = computeTax({
    subtotalCents: 100000n,
    category: 'ROOM',
    rates: DEFAULT_TAX_RATES,
  });
  assert.equal(breakdown.length, 4);
  assert.deepEqual(
    breakdown.map((b) => b.key),
    TAX_COMPONENTS.map((c) => c.key),
    'order must match the reference invoice'
  );
});

test('amounts are BigInt cents, never floats', () => {
  const { taxCents, breakdown } = computeTax({
    subtotalCents: 33333n,
    category: 'ROOM',
    rates: DEFAULT_TAX_RATES,
  });
  assert.equal(typeof taxCents, 'bigint');
  for (const b of breakdown) assert.equal(typeof b.amountCents, 'bigint');
});

test('non-taxable categories produce no tax and no rows', () => {
  for (const category of ['PAYMENT', 'REFUND', 'ADJUSTMENT', 'TAX']) {
    const { taxCents, breakdown } = computeTax({
      subtotalCents: 100000n,
      category,
      rates: DEFAULT_TAX_RATES,
    });
    assert.equal(taxCents, 0n, `${category} must not be taxed`);
    assert.deepEqual(breakdown, [], `${category} must produce no rows`);
  }
});

test('omitted rates fall back to the defaults', () => {
  const withDefaults = computeTax({ subtotalCents: 100000n, category: 'ROOM' });
  const explicit = computeTax({ subtotalCents: 100000n, category: 'ROOM', rates: DEFAULT_TAX_RATES });
  assert.equal(withDefaults.taxCents, explicit.taxCents);
});

test('a partial rates object fills the gaps from the defaults', () => {
  const { breakdown } = computeTax({
    subtotalCents: 100000n,
    category: 'ROOM',
    rates: { localTax: 2 },
  });
  const by = Object.fromEntries(breakdown.map((b) => [b.key, b.amountCents]));
  assert.equal(by.vat, 12000n, 'VAT still uses its default');
  assert.equal(by.localTax, 2000n, 'the supplied rate is used');
});

test('a number-typed subtotal is accepted and returns BigInt', () => {
  // Callers holding a plain Number must not silently produce a float result.
  const { taxCents } = computeTax({ subtotalCents: 100000, category: 'ROOM' });
  assert.equal(taxCents, 22000n);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/folio" && node --test src/lib/policies.test.js
```

Expected: FAIL — `DEFAULT_TAX_RATES` and `TAX_COMPONENTS` are not exported, and `computeTax` returns Numbers with a `name`-keyed breakdown.

- [ ] **Step 3: Rewrite the tax engine in `_shared`**

In `services/_shared/policies.js`, replace the entire `── Tax engine (Philippines defaults) ──` section (the `TAX_RULES` constant and `computeTax`) with:

```js
// ── Tax engine (Philippines defaults) ──────────────────────────────
// Returns { taxCents, breakdown: [{ key, label, rate, amountCents }] }, all
// amounts as BigInt cents.
//
// FOUR COMPONENTS, NOT ONE COMBINED FIGURE
// ----------------------------------------
// The guest folio this system prints itemises tax the way the reference invoice
// does: VAT, service charge, local tax and real property tax on their own lines.
// A single combined number cannot be decomposed back into those rows, so the
// components are computed separately and persisted per transaction.
//
// Note this function was previously dead code — nothing called it, which is why
// every folio in the system carried zero tax until the charge route was wired up
// to it.
//
// RATES ARE PASSED IN, NEVER READ FROM A DATABASE
// -----------------------------------------------
// Keeps this pure and unit-testable. The folio service reads them from its
// AppSetting table and hands them over.
//
// VAT 12% and service charge 10% are the Philippine standards. Local tax and RPT
// default to ZERO deliberately: they vary by locality, and inventing a plausible
// rate would put fabricated tax on a guest's bill. An operator sets them.
const TAX_COMPONENTS = [
  { key: 'vat', label: 'VAT' },
  { key: 'serviceCharge', label: 'Service Charge' },
  { key: 'localTax', label: 'Local Tax' },
  { key: 'realPropertyTax', label: 'Real Property Tax' },
];

const DEFAULT_TAX_RATES = { vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 };

// Categories that are never taxed. An unknown category IS taxed — the safer
// direction of failure for a billing system is to compute tax and have someone
// remove it, not to silently omit it.
const UNTAXED_CATEGORIES = new Set(['PAYMENT', 'REFUND', 'ADJUSTMENT', 'TAX']);

function computeTax({ subtotalCents, category = 'ROOM', rates } = {}) {
  if (UNTAXED_CATEGORIES.has(category)) return { taxCents: 0n, breakdown: [] };

  const effective = { ...DEFAULT_TAX_RATES, ...(rates || {}) };
  const base = BigInt(subtotalCents ?? 0);

  let taxCents = 0n;
  const breakdown = [];
  for (const { key, label } of TAX_COMPONENTS) {
    const rate = Number(effective[key]) || 0;
    // Percent × cents in integer space: multiply by the rate scaled to four
    // decimal places, then divide out. Doing this in floating point loses
    // centavos on large folios, and money must never round through a float.
    const scaled = BigInt(Math.round(rate * 10000));
    const amountCents = (base * scaled + 500000n) / 1000000n;
    taxCents += amountCents;
    breakdown.push({ key, label, rate, amountCents });
  }
  return { taxCents, breakdown };
}
```

Then update the module's export list at the bottom of the file — replace `TAX_RULES` with the two new exports:

```js
module.exports = {
  cancellationFeeCents,
  depositCents,
  computeTax,
  lateCheckoutFeeCents,
  earlyArrivalFeeCents,
  commissionCents,
  TAX_COMPONENTS,
  DEFAULT_TAX_RATES,
  CHANNEL_COMMISSION,
};
```

`TAX_RULES` is removed rather than kept. A repo-wide search confirmed **zero callers** of either `computeTax` or `TAX_RULES`, so nothing depends on the old shape.

- [ ] **Step 4: Vendor the file into every service**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
for d in services/*/src/lib/policies.js; do cp services/_shared/policies.js "$d"; done
bash scripts/check-shared.sh
```

Expected: `check-shared.sh` exits 0 and reports everything in sync.

- [ ] **Step 5: Run the tests to verify they pass**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/folio" && node --test src/lib/policies.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Confirm no service broke on the removed export**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
grep -rn "TAX_RULES" services web --exclude-dir=node_modules; echo "--- want no hits above ---"
for s in folio reservation stay guest audit reports inventory maintenance auth; do
  echo "== $s =="; (cd "services/$s" && npm test 2>&1 | tail -4)
done
```

Expected: no `TAX_RULES` hits, and every service's suite passes.

- [ ] **Step 7: Commit**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
git add services/_shared/policies.js services/*/src/lib/policies.js services/folio/src/lib/policies.test.js
git commit -m "$(cat <<'EOF'
feat: decompose tax into VAT, service charge, local tax and RPT

The guest folio itemises tax on four lines; a single combined figure cannot
be decomposed back into them. Rates are passed in rather than read from a
database so computeTax stays pure, and percentages are applied in integer
space because money must never round through a float.

Local tax and RPT default to zero on purpose -- they vary by locality, and a
plausible-looking invented rate would put fabricated tax on a guest's bill.

computeTax and TAX_RULES had zero callers, so the signature change is safe.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Folio-service settings — tax rates and hotel identity

**Files:**
- Modify: `services/folio/src/prisma/schema.prisma`
- Create: `services/folio/src/prisma/migrations/<timestamp>_add_app_setting/migration.sql` (generated)
- Create: `services/folio/src/lib/settings.js` (**pure** — no Prisma)
- Create: `services/folio/src/lib/settingsStore.js` (Prisma-backed readers/writers)
- Modify: `services/folio/src/routes/folio.routes.js` (add four routes)
- Modify: `services/gateway/nginx.conf` (two locations)
- Test: `services/folio/src/lib/settings.test.js` (create)

**Interfaces:**
- Consumes: `DEFAULT_TAX_RATES` from Task 1.
- Produces:
  - `parseTaxRates(rows)` → a complete rates object, defaults filling any gap.
  - `validateTaxRates(body)` → `{ ok: true, rates }` or `{ ok: false, error }`.
  - `parseHotel(rows)` → `{ name, address, phone, fax, email, url }` with InnSight defaults.
  - `validateHotel(body)` → `{ ok: true, hotel }` or `{ ok: false, error }`.
  - From `settingsStore.js`: `getTaxRates()`, `getHotel()`, `saveTaxRates(rates)`, `saveHotel(hotel)`. Tasks 3 and 5 consume these.
  - `GET`/`PUT /api/settings/tax-rates` and `GET`/`PUT /api/settings/hotel`.

  **`settings.js` must not require Prisma.** `lib/prisma.js` calls `new PrismaClient()` at module load, so a `settings.js` that required it would drag a database client into what is meant to be a pure unit test — the same hazard `authz.test.js` works around by stubbing `require.cache`. The parsers and validators live in `settings.js` with no I/O; everything that touches `prisma.appSetting` lives in `settingsStore.js`, which the route file imports.

- [ ] **Step 1: Write the failing tests**

Create `services/folio/src/lib/settings.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { parseTaxRates, validateTaxRates, parseHotel, TAX_RATE_KEYS } = require('./settings');

test('missing rows fall back to the shipped defaults', () => {
  const rates = parseTaxRates([]);
  assert.deepEqual(rates, { vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 });
});

test('stored rows override the defaults', () => {
  const rates = parseTaxRates([
    { key: 'tax_vat_percent', value: '10' },
    { key: 'tax_local_percent', value: '1.85' },
  ]);
  assert.equal(rates.vat, 10);
  assert.equal(rates.localTax, 1.85);
  assert.equal(rates.serviceCharge, 10, 'an unset key keeps its default');
});

test('a corrupt stored value falls back rather than yielding NaN', () => {
  // A NaN rate would silently produce NaN tax on a guest's bill.
  const rates = parseTaxRates([{ key: 'tax_vat_percent', value: 'twelve' }]);
  assert.equal(rates.vat, 12);
});

test('every component has a settings key', () => {
  assert.deepEqual(Object.keys(TAX_RATE_KEYS).sort(), [
    'localTax', 'realPropertyTax', 'serviceCharge', 'vat',
  ]);
});

test('validation accepts a full, in-range payload', () => {
  const r = validateTaxRates({ vat: 12, serviceCharge: 10, localTax: 1.85, realPropertyTax: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.rates.localTax, 1.85);
});

test('validation accepts a partial payload and keeps the rest at their defaults', () => {
  const r = validateTaxRates({ vat: 8 });
  assert.equal(r.ok, true);
  assert.equal(r.rates.vat, 8);
  assert.equal(r.rates.serviceCharge, 10);
});

test('validation rejects out-of-range and non-numeric rates', () => {
  for (const bad of [{ vat: -1 }, { vat: 101 }, { vat: 'abc' }, { serviceCharge: NaN }, { localTax: Infinity }]) {
    assert.equal(validateTaxRates(bad).ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('validation rejects an unknown key rather than silently dropping it', () => {
  const r = validateTaxRates({ vat: 12, wineTax: 5 });
  assert.equal(r.ok, false);
  assert.match(r.error, /wineTax/);
});

test('hotel identity defaults to InnSight, never to the reference property', () => {
  const hotel = parseHotel([]);
  assert.equal(hotel.name, 'InnSight PMS');
  // The reference invoice belongs to a real business. Shipping its details as
  // defaults would make every printed folio impersonate it.
  const joined = JSON.stringify(hotel).toLowerCase();
  assert.ok(!joined.includes('aureliscita'), 'must not ship a real property as a default');
});

test('stored hotel rows override the defaults', () => {
  const hotel = parseHotel([
    { key: 'hotel_name', value: 'Test Grand Hotel' },
    { key: 'hotel_email', value: 'desk@example.test' },
  ]);
  assert.equal(hotel.name, 'Test Grand Hotel');
  assert.equal(hotel.email, 'desk@example.test');
  assert.equal(typeof hotel.address, 'string', 'unset fields are still present as strings');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/folio" && node --test src/lib/settings.test.js
```

Expected: FAIL — `Cannot find module './settings'`.

- [ ] **Step 3: Create the settings library**

Create `services/folio/src/lib/settings.js`:

```js
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
```

Then create `services/folio/src/lib/settingsStore.js` — everything that touches the database:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/folio" && node --test src/lib/settings.test.js
```

Expected: all tests PASS, and the run must not need a database — that is the point of keeping `settings.js` free of Prisma. The `settingsStore.js` helpers are covered by manual verification.

- [ ] **Step 5: Add the `AppSetting` model and migrate**

Append to `services/folio/src/prisma/schema.prisma`:

```prisma
// Folio-service configuration: tax component rates and the hotel identity block
// printed at the top of a guest folio. Mirrors the reservation service's
// AppSetting rather than sharing it, because posting a charge must not depend on
// the reservation service being reachable.
model AppSetting {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt
}
```

Generate the migration:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/folio"
npx prisma migrate dev --schema=src/prisma/schema.prisma --name add_app_setting
```

Expected: a new directory under `src/prisma/migrations/` containing a `CREATE TABLE "AppSetting"`. If the database is not running, start it first (`docker compose up -d postgres`).

- [ ] **Step 6: Add the four settings routes**

In `services/folio/src/routes/folio.routes.js`, add the import beside the other `lib/` requires at the top:

```js
const { validateTaxRates, validateHotel } = require('../lib/settings');
const { getTaxRates, getHotel, saveTaxRates, saveHotel } = require('../lib/settingsStore');
```

Then add the routes near the other top-level routes (placement is not load-bearing — none of these paths collide with a `:id` param route):

```js
// ── Folio configuration ─────────────────────────────────────────────────────
// Reachable only through the longer-prefix gateway locations for
// /api/settings/tax-rates and /api/settings/hotel; the bare /api/settings prefix
// still proxies to the reservation service.

// GET /api/settings/tax-rates — every desk role, because the folio screen shows
// the rates a charge will attract.
router.get('/settings/tax-rates', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (_req, res) => {
  try {
    res.json(await getTaxRates());
  } catch (err) {
    console.error('[Folio] Get tax rates error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/settings/tax-rates — management only. These change what guests are
// billed.
router.put('/settings/tax-rates', requireRole(...ROLE_GROUPS.MGMT), async (req, res) => {
  try {
    const result = validateTaxRates(req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(await saveTaxRates(result.rates));
  } catch (err) {
    console.error('[Folio] Set tax rates error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/settings/hotel — the identity block printed on a folio.
router.get('/settings/hotel', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (_req, res) => {
  try {
    res.json(await getHotel());
  } catch (err) {
    console.error('[Folio] Get hotel error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/settings/hotel — management only.
router.put('/settings/hotel', requireRole(...ROLE_GROUPS.MGMT), async (req, res) => {
  try {
    const result = validateHotel(req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(await saveHotel(result.hotel));
  } catch (err) {
    console.error('[Folio] Set hotel error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});
```

- [ ] **Step 7: Add the gateway locations**

In `services/gateway/nginx.conf`, immediately **before** the existing `location /api/settings { proxy_pass http://$up_reservation; }` line (line 275), add:

```nginx
        # Tax rates and hotel identity live on the FOLIO service — posting a
        # charge must not depend on the reservation service being reachable.
        # nginx resolves prefix locations longest-match-first, so these win over
        # the /api/settings catch-all below without disturbing the add-on
        # surcharge and theme routes behind it.
        location /api/settings/tax-rates { proxy_pass http://$up_folio; }
        location /api/settings/hotel     { proxy_pass http://$up_folio; }
```

Confirm `$up_folio` is the variable name actually in use:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS" && grep -n "up_folio" services/gateway/nginx.conf | head -3
```

If the variable is named differently, use the name the file defines.

- [ ] **Step 8: Verify the authz audit still passes**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/folio" && npm test
```

Expected: all PASS. `authz.test.js` walks the router and fails on any unguarded route; the four new routes all carry `requireRole(...)`, so they are covered automatically — there is no table to edit.

- [ ] **Step 9: Verify the gateway config parses**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
docker compose up -d --build gateway
docker compose exec gateway nginx -t
```

Expected: `syntax is ok` / `test is successful`. `nginx.conf` is baked into the image, so `--build` is required — a plain restart serves the old config.

- [ ] **Step 10: Commit**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
git add services/folio/src/prisma/schema.prisma services/folio/src/prisma/migrations \
        services/folio/src/lib/settings.js services/folio/src/lib/settingsStore.js \
        services/folio/src/lib/settings.test.js \
        services/folio/src/routes/folio.routes.js services/gateway/nginx.conf
git commit -m "$(cat <<'EOF'
feat: folio-service settings for tax rates and hotel identity

Its own AppSetting table rather than the reservation service's: posting a
charge is a hot write path and must not depend on another service being up.

Needs two longer-prefix gateway locations, because /api/settings proxies
everything under it to the reservation service. nginx.conf is baked into the
image, so the gateway needs a rebuild.

Hotel identity defaults to InnSight, never to the reference invoice's real
property. A corrupt stored rate falls back to its default rather than
becoming NaN tax on a guest's bill.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Persist the tax breakdown and wire up charge posting

**Files:**
- Modify: `services/folio/src/prisma/schema.prisma` (`FolioTransaction`)
- Create: `services/folio/src/prisma/migrations/<timestamp>_add_tax_breakdown/migration.sql` (generated)
- Modify: `services/folio/src/routes/folio.routes.js:590-640` (the charges route)
- Test: `services/folio/src/lib/folioSummary.test.js` (add cases; do not edit existing ones)

**Interfaces:**
- Consumes: `computeTax`, `DEFAULT_TAX_RATES` (Task 1); `getTaxRates()` (Task 2).
- Produces: `FolioTransaction.taxBreakdown` — `Json?`, an array of `{ key, label, rate, amountCents }` where `amountCents` is a **decimal string** (JSON cannot carry BigInt). Task 4 reads this column.

- [ ] **Step 1: Add the column and migrate**

In `services/folio/src/prisma/schema.prisma`, add one field to `FolioTransaction`, directly after `taxAmountCents`:

```prisma
  taxAmountCents    BigInt           @default(0)
  // Per-component tax for the printed folio: [{ key, label, rate, amountCents }]
  // with amountCents as a decimal STRING, because JSON cannot carry BigInt.
  //
  // taxAmountCents above stays the single source of truth for every total and
  // balance — this column is presentation detail layered on top. Rows written
  // before this migration are null and print their whole tax as VAT, so no
  // historical folio's figures move.
  taxBreakdown      Json?
```

Generate the migration:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/folio"
npx prisma migrate dev --schema=src/prisma/schema.prisma --name add_tax_breakdown
```

Expected: a migration containing `ALTER TABLE "FolioTransaction" ADD COLUMN "taxBreakdown" JSONB`. Confirm it is **nullable with no default** — a `NOT NULL` column here would fail against existing rows.

**Then make it idempotent:** edit the generated SQL to `ADD COLUMN IF NOT EXISTS`. `scripts/db-init.sh:60-75` re-executes every non-baseline `migration.sql` on **every container start** — its own header states "Every one of those files is written to be idempotent (CREATE ... IF NOT EXISTS / DROP CONSTRAINT IF EXISTS)". A plain `ADD COLUMN` throws on the second start and crash-loops the folio service. This was confirmed empirically in Task 2, whose `CREATE TABLE` needed the same treatment.

- [ ] **Step 2: Write the failing test for the compatibility invariant**

Append to `services/folio/src/lib/folioSummary.test.js`. **Do not modify any existing test in this file** — they are the regression gate proving totals did not move:

```js
// ─────────────────────────────────────────────────────────────────────────────
// taxBreakdown is presentation detail. classifyTransactions must keep reading
// taxAmountCents ALONE, so a row written before the breakdown column existed
// produces exactly the same totals as one written after it.
// ─────────────────────────────────────────────────────────────────────────────

test('a transaction with a breakdown totals identically to one without', () => {
  const withBreakdown = classifyTransactions(
    [
      {
        type: 'CHARGE', chargeCode: 'RM', amountCents: 2535000n, taxAmountCents: 557700n,
        taxBreakdown: [
          { key: 'vat', label: 'VAT', rate: 12, amountCents: '304200' },
          { key: 'serviceCharge', label: 'Service Charge', rate: 10, amountCents: '253500' },
          { key: 'localTax', label: 'Local Tax', rate: 0, amountCents: '0' },
          { key: 'realPropertyTax', label: 'Real Property Tax', rate: 0, amountCents: '0' },
        ],
      },
    ],
    ROOM_CODES
  );
  const without = classifyTransactions(
    [{ type: 'CHARGE', chargeCode: 'RM', amountCents: 2535000n, taxAmountCents: 557700n }],
    ROOM_CODES
  );
  assert.deepEqual(withBreakdown, without, 'the breakdown must not affect any total');
  assert.equal(withBreakdown.taxCents, 557700n);
  assert.equal(withBreakdown.totalChargesCents, 3092700n);
});

test('a null breakdown is ignored entirely', () => {
  const result = classifyTransactions(
    [{ type: 'CHARGE', chargeCode: 'RM', amountCents: 100000n, taxAmountCents: 12000n, taxBreakdown: null }],
    ROOM_CODES
  );
  assert.equal(result.taxCents, 12000n);
  assert.equal(result.balanceCents, 112000n);
});
```

- [ ] **Step 3: Run the tests**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/folio" && node --test src/lib/folioSummary.test.js
```

Expected: **all tests PASS immediately, including the two new ones.** `classifyTransactions` already ignores unknown fields, so no implementation change is needed. These tests exist to *lock in* that property so a later refactor cannot start reading `taxBreakdown` for totals. If either new test fails, `classifyTransactions` was changed and must be reverted.

- [ ] **Step 4: Wire charge posting to `computeTax`**

In `services/folio/src/routes/folio.routes.js`, in `POST /api/folios/:id/charges`, replace the block from `const baseCents = parseCents(amountCents);` through the `prisma.folioTransaction.create({...})` call with:

```js
    const baseCents = parseCents(amountCents);
    if (baseCents === null) {
      return res.status(400).json({ error: 'amountCents must be a non-negative integer.' });
    }
    const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
    const totalCents = baseCents * BigInt(qty);

    let resolvedDesc = description;
    const cc = chargeCode ? await prisma.chargeCode.findUnique({ where: { code: chargeCode } }) : null;
    if (!resolvedDesc && chargeCode) resolvedDesc = cc?.name || chargeCode;

    // Tax. An explicit taxAmountCents from the caller still WINS — the night
    // audit and other programmatic posters supply their own figure and must keep
    // their current behaviour. Only when none is supplied is tax computed here.
    //
    // This is the wiring that was missing: computeTax existed but nothing called
    // it, and the UI never sent taxAmountCents, so every folio in the system
    // carried zero tax.
    let totalTaxCents;
    let taxBreakdown = null;
    if (taxAmountCents !== undefined) {
      const taxCents = parseCents(taxAmountCents);
      if (taxCents === null) {
        return res.status(400).json({ error: 'taxAmountCents must be a non-negative integer.' });
      }
      totalTaxCents = taxCents * BigInt(qty);
    } else if (cc && cc.taxable === false) {
      // A charge code explicitly marked non-taxable attracts no tax.
      totalTaxCents = 0n;
    } else {
      const rates = await getTaxRates();
      const { taxCents, breakdown } = computeTax({
        subtotalCents: totalCents,
        category: cc?.category || 'OTHER',
        rates,
      });
      totalTaxCents = taxCents;
      // BigInt cannot be JSON-serialised, so amounts are stored as decimal
      // strings. Readers parse them back with BigInt().
      taxBreakdown = breakdown.map((b) => ({ ...b, amountCents: b.amountCents.toString() }));
    }

    const tx = await prisma.folioTransaction.create({
      data: {
        folioId: req.params.id,
        type: 'CHARGE',
        chargeCode,
        description: resolvedDesc || 'Charge',
        amountCents: totalCents,
        taxAmountCents: totalTaxCents,
        taxBreakdown,
        quantity: qty,
        note,
        postedBy: postedBy || req.user?.username || req.user?.sub,
        sourceSystem,
        reference,
      },
    });
```

Add `computeTax` to the `policies` import at the top of the file if it is not already imported:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS" && grep -n "require('../lib/policies')" services/folio/src/routes/folio.routes.js
```

If there is no such import, add `const { computeTax } = require('../lib/policies');` beside the other `lib/` requires.

Note the charge-code lookup moved earlier and is now done **once** — it previously ran only when the description was blank, and the category is needed for tax.

- [ ] **Step 5: Run the folio suite**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/folio" && npm test
```

Expected: all PASS.

- [ ] **Step 6: Verify the reversal path still balances**

`folio.routes.js:821` posts `taxAmountCents: -original.taxAmountCents` when reversing. Confirm it was not disturbed:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
grep -n "taxAmountCents: -original.taxAmountCents" services/folio/src/routes/folio.routes.js
```

Expected: one hit, unchanged. A reversal deliberately carries **no** `taxBreakdown` — it negates a total, and half a breakdown would print as a phantom tax line.

- [ ] **Step 7: Commit**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
git add services/folio/src/prisma/schema.prisma services/folio/src/prisma/migrations \
        services/folio/src/routes/folio.routes.js services/folio/src/lib/folioSummary.test.js
git commit -m "$(cat <<'EOF'
feat: persist the per-component tax breakdown and compute tax on posting

computeTax was dead code and the UI never sent taxAmountCents, so every folio
in the system carried zero tax. Charge posting now computes it when the caller
supplies none; an explicit figure still wins, so the night audit is unaffected.

taxAmountCents remains the single source of truth for every total. The new
column is nullable, pre-migration rows print their whole tax as VAT, and
folioSummary.test.js now locks in that a breakdown cannot affect a balance.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The printed folio — pure model

**Files:**
- Create: `services/folio/src/lib/folioPrintModel.js`
- Test: `services/folio/src/lib/folioPrintModel.test.js` (create)

**Interfaces:**
- Consumes: `classifyTransactions` (`./folioSummary`), `TAX_COMPONENTS` (`./policies`), `centsToWords` (`./receiptWords`).
- Produces: `folioPrintModel({ folio, transactions, summary, guest, stay, reservation, hotel })` → the structured document Task 5 renders. Shape:

  ```
  { hotel, meta: { folioNumber, date, guestName, nationality, pax, adults, children,
                   grCardNo, arrival, departure, arrivalTime, tariffCents },
    sections: [{ title, rows: [{ label, amountCents }], subtotalCents }],
    totals: { totalChargesCents, totalPaymentCents, balanceCents },
    footer: { currency, billTo, address, amountInWords, remark } }
  ```

  All `*Cents` values are `BigInt`.

- [ ] **Step 1: Write the failing tests**

Create `services/folio/src/lib/folioPrintModel.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { folioPrintModel } = require('./folioPrintModel');
const { classifyTransactions } = require('./folioSummary');

const ROOM_CODES = { roomCodes: new Set(['RM']), facilityCodes: new Set(['POOL']) };

function build(transactions, extra = {}) {
  // The route tags each charge with whether it is room revenue; the model relies
  // on that flag rather than re-deriving the classification.
  const tagged = transactions.map((t) => ({ ...t, __isRoom: ROOM_CODES.roomCodes.has(t.chargeCode) }));
  const summary = classifyTransactions(tagged, ROOM_CODES);
  return folioPrintModel({
    folio: { folioNumber: '11', currency: 'PHP' },
    transactions: tagged,
    summary,
    guest: { nationality: 'Filipino' },
    stay: { actualCheckInAt: '2025-05-21T03:58:19.000Z' },
    reservation: {
      checkIn: '2025-05-21T00:00:00.000Z', checkOut: '2025-05-25T00:00:00.000Z',
      adults: 2, children: 3, nights: 3, confirmationNumber: 'CN-11',
    },
    hotel: { name: 'Test Hotel', address: '', phone: '', fax: '', email: '', url: '' },
    ...extra,
  });
}

function sectionNamed(model, title) {
  const s = model.sections.find((x) => x.title === title);
  assert.ok(s, `expected a "${title}" section`);
  return s;
}

// The reference invoice, reproduced. 3 nights at 8,450.00 = 25,350.00 room
// charge, VAT 3,042.00 and service charge 2,535.00.
const REFERENCE_TX = [
  {
    type: 'CHARGE', chargeCode: 'RM', description: 'Room charge',
    amountCents: 2535000n, taxAmountCents: 557700n,
    taxBreakdown: [
      { key: 'vat', label: 'VAT', rate: 12, amountCents: '304200' },
      { key: 'serviceCharge', label: 'Service Charge', rate: 10, amountCents: '253500' },
      { key: 'localTax', label: 'Local Tax', rate: 0, amountCents: '0' },
      { key: 'realPropertyTax', label: 'Real Property Tax', rate: 0, amountCents: '0' },
    ],
  },
];

test('the header block carries the guest and stay facts the reference shows', () => {
  const m = build(REFERENCE_TX);
  assert.equal(m.meta.folioNumber, '11');
  assert.equal(m.meta.nationality, 'Filipino');
  assert.equal(m.meta.pax, 5, 'adults + children');
  assert.equal(m.meta.adults, 2);
  assert.equal(m.meta.children, 3);
  assert.equal(m.meta.grCardNo, 'CN-11', 'the confirmation number stands in for the G.R. card');
  assert.equal(m.meta.tariffCents, 845000n, '25,350.00 over 3 nights');
});

test('room tax renders all four components in reference order', () => {
  const m = build(REFERENCE_TX);
  const tax = sectionNamed(m, 'Add : Room Tax');
  assert.deepEqual(
    tax.rows.map((r) => r.label),
    ['VAT', 'Service Charge', 'Local Tax', 'Real Property Tax']
  );
  assert.equal(tax.rows[0].amountCents, 304200n);
  assert.equal(tax.rows[1].amountCents, 253500n);
  assert.equal(tax.subtotalCents, 557700n);
});

// The compatibility rule: a folio posted before the breakdown column existed
// must still print, with its whole tax on the VAT line and the SAME total.
test('a null breakdown attributes the whole tax to VAT', () => {
  const m = build([
    { type: 'CHARGE', chargeCode: 'RM', description: 'Room charge',
      amountCents: 2535000n, taxAmountCents: 557700n, taxBreakdown: null },
  ]);
  const tax = sectionNamed(m, 'Add : Room Tax');
  assert.equal(tax.rows[0].label, 'VAT');
  assert.equal(tax.rows[0].amountCents, 557700n);
  assert.equal(tax.rows[1].amountCents, 0n, 'nothing is invented for the other components');
  assert.equal(tax.subtotalCents, 557700n, 'the total is unchanged');
});

// The reference prints Room Charges gross with Less Discount beneath. The
// classifier already nets a negative room charge in, so printing its figure as
// "Room Charges" AND the discount again would deduct it twice.
test('a room discount shows gross, the deduction, and a correct net subtotal', () => {
  const m = build([
    { type: 'CHARGE', chargeCode: 'RM', description: 'Room charge', amountCents: 2535000n, taxAmountCents: 0n },
    { type: 'CHARGE', chargeCode: 'RM', description: 'Corporate rate', amountCents: -35000n, taxAmountCents: 0n },
  ]);
  const room = sectionNamed(m, 'Room Charges');
  assert.equal(room.rows[0].amountCents, 2535000n, 'gross, before the discount');
  assert.equal(room.rows[1].amountCents, 35000n, 'the deduction, shown positive');
  assert.equal(room.subtotalCents, 2500000n, 'net — and it must not be deducted twice');
  assert.equal(m.totals.balanceCents, 2500000n);
});

test('with no discount, gross equals the subtotal and the discount row is zero', () => {
  const m = build(REFERENCE_TX);
  const room = sectionNamed(m, 'Room Charges');
  assert.equal(room.rows[0].amountCents, 2535000n);
  assert.equal(room.rows[1].amountCents, 0n);
  assert.equal(room.subtotalCents, 2535000n);
});

test('the room tax subtotal always equals the summary tax on room charges', () => {
  const m = build(REFERENCE_TX);
  const tax = sectionNamed(m, 'Add : Room Tax');
  const onCharges = sectionNamed(m, 'Add : Tax On Charges');
  assert.equal(tax.subtotalCents + onCharges.subtotalCents, 557700n);
});

test('non-room tax lands in Tax On Charges, not Room Tax', () => {
  const m = build([
    { type: 'CHARGE', chargeCode: 'RM', description: 'Room', amountCents: 100000n, taxAmountCents: 12000n,
      taxBreakdown: [{ key: 'vat', label: 'VAT', rate: 12, amountCents: '12000' }] },
    { type: 'CHARGE', chargeCode: 'MB', description: 'Minibar', amountCents: 50000n, taxAmountCents: 6000n,
      taxBreakdown: [{ key: 'vat', label: 'VAT', rate: 12, amountCents: '6000' }] },
  ]);
  assert.equal(sectionNamed(m, 'Add : Room Tax').subtotalCents, 12000n);
  assert.equal(sectionNamed(m, 'Add : Tax On Charges').subtotalCents, 6000n);
  assert.equal(sectionNamed(m, 'Add : Extra Charges').subtotalCents, 50000n);
});

test('transfers split into the From and To sections by sign', () => {
  const m = build([
    { type: 'TRANSFER', chargeCode: 'RM', description: 'From folio 12', amountCents: 30000n, taxAmountCents: 0n },
    { type: 'TRANSFER', chargeCode: 'RM', description: 'To folio 13', amountCents: -20000n, taxAmountCents: 0n },
  ]);
  assert.equal(sectionNamed(m, 'Add : Transferred From Folio').subtotalCents, 30000n);
  assert.equal(sectionNamed(m, 'Less : Transferred To Folio').subtotalCents, 20000n, 'shown as a positive deduction');
});

test('payments appear under Less : Amount Paid, net of refunds', () => {
  const m = build([
    { type: 'CHARGE', chargeCode: 'RM', description: 'Room', amountCents: 100000n, taxAmountCents: 0n },
    { type: 'PAYMENT', chargeCode: null, description: 'Cash', amountCents: 60000n, taxAmountCents: 0n },
    { type: 'REFUND', chargeCode: null, description: 'Refund', amountCents: 10000n, taxAmountCents: 0n },
  ]);
  assert.equal(sectionNamed(m, 'Less : Amount Paid').subtotalCents, 50000n);
  assert.equal(m.totals.totalPaymentCents, 50000n);
  assert.equal(m.totals.balanceCents, 50000n);
});

// The whole point of the document: the right-hand rail must agree with the
// classifier every other part of the system bills from.
test('totals match classifyTransactions exactly', () => {
  const tx = [
    { type: 'CHARGE', chargeCode: 'RM', description: 'Room', amountCents: 2535000n, taxAmountCents: 557700n, taxBreakdown: null },
    { type: 'CHARGE', chargeCode: 'MB', description: 'Minibar', amountCents: 50000n, taxAmountCents: 6000n, taxBreakdown: null },
    { type: 'PAYMENT', chargeCode: null, description: 'Cash', amountCents: 100000n, taxAmountCents: 0n },
    { type: 'ADJUSTMENT', chargeCode: null, description: 'Goodwill', amountCents: -5000n, taxAmountCents: 0n },
  ];
  const summary = classifyTransactions(tx, ROOM_CODES);
  const m = build(tx);
  assert.equal(m.totals.totalChargesCents, summary.totalChargesCents);
  assert.equal(m.totals.balanceCents, summary.balanceCents);
});

test('every section is present even when empty, so the layout never collapses', () => {
  const m = build([]);
  for (const title of [
    'Room Charges', 'Add : Room Tax', 'Add : Extra Charges', 'Add : Tax On Charges',
    'Add : Transferred From Folio', 'Less : Flat Discount', 'Less : Amount Paid',
    'Less : Transferred To Folio', 'Adjustment',
  ]) {
    sectionNamed(m, title);
  }
  assert.equal(m.totals.balanceCents, 0n);
});

test('the balance is rendered in words', () => {
  const m = build(REFERENCE_TX);
  assert.match(m.footer.amountInWords.toUpperCase(), /THIRTY/);
});

test('the guest nationality stands in for the address line', () => {
  const m = build(REFERENCE_TX);
  assert.equal(m.footer.address, 'Filipino');
  assert.equal(m.footer.currency, 'PHP');
});

test('missing guest, stay and reservation degrade to dashes, never throw', () => {
  const m = build(REFERENCE_TX, { guest: null, stay: null, reservation: null });
  assert.equal(m.meta.nationality, '—');
  assert.equal(m.meta.grCardNo, '—');
  assert.equal(m.meta.pax, '—');
  // Staff need folios to print during an audit even when an upstream is down.
  assert.equal(m.totals.balanceCents, 3092700n);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/folio" && node --test src/lib/folioPrintModel.test.js
```

Expected: FAIL — `Cannot find module './folioPrintModel'`.

- [ ] **Step 3: Implement the model**

Create `services/folio/src/lib/folioPrintModel.js`:

```js
// The guest folio as a structured document, separated from its rendering so the
// arithmetic on a guest's bill can be unit-tested without producing a PDF.
//
// The layout follows the panel's reference invoice
// (10 - References/FELISMINO-JANA-MARIE_GUEST-FOLIO.pdf) section for section.
//
// EVERY SECTION IS ALWAYS PRESENT, even at zero. The reference is a fixed grid,
// and a form that grows and shrinks row by row stops being recognisable as the
// same document — staff read these by position.

const { TAX_COMPONENTS } = require('./policies');
const { centsToWords } = require('./receiptWords');

const DASH = '—';

// Sum one component across a set of transactions, falling back to VAT for rows
// written before the taxBreakdown column existed.
//
// The fallback is what keeps historical folios printing the SAME total they
// always did: their whole taxAmountCents lands on VAT rather than being invented
// across four lines or dropped.
function taxByComponent(transactions) {
  const totals = Object.fromEntries(TAX_COMPONENTS.map((c) => [c.key, 0n]));
  for (const tx of transactions) {
    const tax = BigInt(tx.taxAmountCents || 0);
    if (tax === 0n) continue;
    const rows = Array.isArray(tx.taxBreakdown) ? tx.taxBreakdown : null;
    if (!rows || rows.length === 0) {
      totals.vat += tax;
      continue;
    }
    let attributed = 0n;
    for (const row of rows) {
      if (!(row.key in totals)) continue;
      const amt = BigInt(row.amountCents || 0);
      totals[row.key] += amt;
      attributed += amt;
    }
    // A breakdown that does not account for the whole tax would make the folio's
    // sections disagree with its balance. Put the remainder on VAT rather than
    // letting money vanish off the document.
    if (attributed !== tax) totals.vat += tax - attributed;
  }
  return totals;
}

function componentRows(totals) {
  return TAX_COMPONENTS.map((c) => ({ label: c.label, amountCents: totals[c.key] }));
}

function sumRows(rows) {
  return rows.reduce((a, r) => a + r.amountCents, 0n);
}

function fmtDate(d) {
  if (!d) return DASH;
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return DASH;
  // Reference format: M/D/YYYY.
  return `${x.getUTCMonth() + 1}/${x.getUTCDate()}/${x.getUTCFullYear()}`;
}

function fmtTime(d) {
  if (!d) return DASH;
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return DASH;
  return x.toISOString().slice(11, 19);
}

function folioPrintModel({
  folio,
  transactions = [],
  summary,
  guest = null,
  stay = null,
  reservation = null,
  hotel = {},
}) {
  const charges = transactions.filter((t) => t.type === 'CHARGE' || t.type === 'TRANSFER');
  const roomCharges = charges.filter((t) => t.__isRoom);
  const otherCharges = charges.filter((t) => !t.__isRoom);

  // classifyTransactions has already done the room/facility/extra split; reuse
  // its totals rather than re-deriving them, so the document can never disagree
  // with the balance the desk is blocked on.
  const roomTax = taxByComponent(roomCharges);
  const otherTax = taxByComponent(otherCharges);

  const transfersIn = transactions.filter((t) => t.type === 'TRANSFER' && BigInt(t.amountCents) > 0n);
  const transfersOut = transactions.filter((t) => t.type === 'TRANSFER' && BigInt(t.amountCents) < 0n);
  const discounts = transactions.filter(
    (t) => t.type === 'ADJUSTMENT' && BigInt(t.amountCents) < 0n
  );
  const otherAdjustments = transactions.filter(
    (t) => t.type === 'ADJUSTMENT' && BigInt(t.amountCents) >= 0n
  );

  const roomTaxRows = componentRows(roomTax);
  const chargeTaxRows = componentRows(otherTax);

  const discountRows = discounts.map((t) => ({
    label: t.description || 'Discount',
    amountCents: -BigInt(t.amountCents),
  }));
  const adjustmentRows = otherAdjustments.map((t) => ({
    label: t.description || 'Adjustment',
    amountCents: BigInt(t.amountCents),
  }));
  const transferInRows = transfersIn.map((t) => ({
    label: t.description || 'Folio Transferred',
    amountCents: BigInt(t.amountCents),
  }));
  const transferOutRows = transfersOut.map((t) => ({
    label: t.description || 'Folio Transferred',
    amountCents: -BigInt(t.amountCents),
  }));

  const nights = reservation?.nights || 1;
  const tariffCents = summary.roomChargeCents / BigInt(nights || 1);

  const guestName = stay?.guestName || reservation?.guestName || DASH;

  // The reference shows Room Charges GROSS with a Less Discount line beneath,
  // netting to the subtotal. classifyTransactions already nets a negative room
  // charge into roomChargeCents, so the gross figure is recovered by adding the
  // discounts back — printing summary.roomChargeCents as "Room Charges" AND the
  // discounts again would deduct them twice.
  const roomDiscountCents = roomCharges
    .filter((t) => BigInt(t.amountCents) < 0n)
    .reduce((a, t) => a - BigInt(t.amountCents), 0n);
  const roomGrossCents = summary.roomChargeCents + roomDiscountCents;

  const sections = [
    {
      title: 'Room Charges',
      rows: [
        { label: 'Room Charges', amountCents: roomGrossCents },
        { label: 'Less Discount', amountCents: roomDiscountCents },
      ],
      // Gross minus discount — identical to what the classifier billed.
      subtotalCents: summary.roomChargeCents,
    },
    { title: 'Add : Room Tax', rows: roomTaxRows, subtotalCents: sumRows(roomTaxRows) },
    {
      title: 'Add : Extra Charges',
      rows: [
        {
          label: 'Extra Charges',
          amountCents: summary.extraChargeCents + summary.facilityChargeCents,
        },
      ],
      subtotalCents: summary.extraChargeCents + summary.facilityChargeCents,
    },
    { title: 'Add : Tax On Charges', rows: chargeTaxRows, subtotalCents: sumRows(chargeTaxRows) },
    {
      title: 'Add : Transferred From Folio',
      rows: transferInRows.length ? transferInRows : [{ label: 'Folio Transferred', amountCents: 0n }],
      subtotalCents: sumRows(transferInRows),
    },
    {
      title: 'Less : Flat Discount',
      rows: discountRows.length ? discountRows : [{ label: 'Flat Discount', amountCents: 0n }],
      subtotalCents: sumRows(discountRows),
    },
    {
      title: 'Less : Amount Paid',
      rows: [{ label: 'Payment By Guest', amountCents: summary.netPaymentsCents }],
      subtotalCents: summary.netPaymentsCents,
    },
    {
      title: 'Less : Transferred To Folio',
      rows: transferOutRows.length ? transferOutRows : [{ label: 'Folio Transferred', amountCents: 0n }],
      subtotalCents: sumRows(transferOutRows),
    },
    {
      title: 'Adjustment',
      rows: adjustmentRows.length ? adjustmentRows : [{ label: 'Adjustment', amountCents: 0n }],
      subtotalCents: sumRows(adjustmentRows),
    },
  ];

  return {
    hotel: {
      name: hotel.name || 'InnSight PMS',
      address: hotel.address || '',
      phone: hotel.phone || '',
      fax: hotel.fax || '',
      email: hotel.email || '',
      url: hotel.url || '',
    },
    meta: {
      folioNumber: folio.folioNumber,
      date: fmtDate(new Date()),
      guestName,
      nationality: guest?.nationality || DASH,
      pax: reservation ? (reservation.adults || 0) + (reservation.children || 0) : DASH,
      adults: reservation?.adults ?? DASH,
      children: reservation?.children ?? DASH,
      // InnSight has no physical registration card; the confirmation number is
      // the identifier a guest is actually asked for.
      grCardNo: reservation?.confirmationNumber || DASH,
      arrival: fmtDate(stay?.actualCheckInAt || reservation?.checkIn),
      departure: fmtDate(stay?.actualCheckOutAt || reservation?.checkOut),
      arrivalTime: fmtTime(stay?.actualCheckInAt),
      tariffCents,
    },
    sections,
    totals: {
      totalChargesCents: summary.totalChargesCents,
      totalPaymentCents: summary.netPaymentsCents,
      balanceCents: summary.balanceCents,
    },
    footer: {
      currency: folio.currency || 'PHP',
      billTo: guestName,
      // Guest has no address field, and the reference's own Address line reads
      // only "Philippines". Nationality is the closest true fact this system holds.
      address: guest?.nationality || DASH,
      amountInWords: centsToWords(summary.balanceCents),
      remark: '',
    },
  };
}

module.exports = { folioPrintModel, taxByComponent };
```

The model expects each charge transaction to carry a boolean `__isRoom`, set by the caller that knows the charge-code categories. Task 5 sets it.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/folio" && node --test src/lib/folioPrintModel.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
git add services/folio/src/lib/folioPrintModel.js services/folio/src/lib/folioPrintModel.test.js
git commit -m "$(cat <<'EOF'
feat: folioPrintModel -- the guest folio as a testable structure

Separates the arithmetic on a guest's bill from pdfkit, so it can be unit
tested. Every section is always present even at zero: the reference is a fixed
grid and staff read these by position.

A transaction with no taxBreakdown attributes its whole tax to VAT, and a
breakdown that does not account for the full amount puts the remainder there
too -- the sections can never disagree with the balance.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Render the folio to the reference layout

**Files:**
- Modify: `services/folio/src/routes/folio.routes.js:1400-1518` (the print route)

**Interfaces:**
- Consumes: `folioPrintModel` (Task 4), `getHotel()` (Task 2), `classifyTransactions`, `centsToWords`.
- Produces: `GET /api/folios/:id/print` → a bordered A4 PDF. Same URL, same auth, same filename convention.

- [ ] **Step 1: Replace the print route**

In `services/folio/src/routes/folio.routes.js`, replace the whole `GET /folios/:id/print` route with:

```js
// GET /api/folios/:id/print — the guest folio as a PDF, laid out to match the
// panel's reference invoice: a bordered grid with every section always present.
//
// The arithmetic lives in lib/folioPrintModel.js so it can be unit tested; this
// route is rendering only.
router.get('/folios/:id/print', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const folio = await prisma.folio.findUnique({
      where: { id: req.params.id },
      include: { transactions: { orderBy: { postedAt: 'asc' } } },
    });
    if (!folio) return res.status(404).json({ error: 'Not found.' });

    const codeRows = await prisma.chargeCode.findMany({
      where: { category: { in: ['ROOM', 'FACILITY'] } },
      select: { code: true, category: true },
    });
    const roomCodes = new Set(codeRows.filter((c) => c.category === 'ROOM').map((c) => c.code));
    const facilityCodes = new Set(codeRows.filter((c) => c.category === 'FACILITY').map((c) => c.code));

    // Tag each transaction with whether it is room revenue, so the print model
    // can split room tax from tax on other charges without re-deriving the
    // classification.
    const transactions = folio.transactions.map((t) => ({
      ...t,
      __isRoom: roomCodes.has(t.chargeCode),
    }));
    const summary = classifyTransactions(transactions, { roomCodes, facilityCodes });

    // Upstream failures degrade to a dash rather than failing the print: staff
    // need folios to print during an audit even when a service is down.
    const guest = folio.guestId
      ? await fetchJsonOrNull(`${GUEST_URL}/api/guests/${encodeURIComponent(folio.guestId)}`)
      : null;
    const stay = folio.stayId
      ? await fetchJsonOrNull(`${STAY_URL}/api/stays/${encodeURIComponent(folio.stayId)}`)
      : null;
    const reservation = stay?.reservationId
      ? await fetchJsonOrNull(`${RESERVATION_URL}/api/reservations/${encodeURIComponent(stay.reservationId)}`)
      : null;

    const model = folioPrintModel({
      folio, transactions, summary,
      guest, stay, reservation, hotel: await getHotel(),
    });

    // The reference prints amounts as "25,350.00 P".
    const money = (cents) =>
      `${(Number(cents) / 100).toLocaleString('en-US', {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      })} P`;

    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="folio-${folio.folioNumber}.pdf"`);
    doc.pipe(res);

    const L = 36;                       // left margin
    const R = doc.page.width - 36;      // right margin
    const W = R - L;
    const SPLIT = L + W * 0.72;         // where the Particular column ends

    // ── Hotel header ──
    doc.font('Helvetica-Bold').fontSize(15).text(model.hotel.name, L, 40, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(8);
    for (const line of [
      model.hotel.address,
      [model.hotel.phone && `Phone: ${model.hotel.phone}`,
       model.hotel.fax && `Fax: ${model.hotel.fax}`,
       model.hotel.email && `E-Mail: ${model.hotel.email}`].filter(Boolean).join(' ; '),
      model.hotel.url && `URL: ${model.hotel.url}`,
    ].filter(Boolean)) {
      doc.text(line, L, doc.y, { width: W, align: 'center' });
    }
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(10).text('Invoice', L, doc.y, { width: W, align: 'center' });
    doc.moveDown(0.5);

    // ── Boxed helpers ──
    const cell = (x, y, w, h, text, opts = {}) => {
      doc.rect(x, y, w, h).stroke();
      if (text == null || text === '') return;
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 8);
      doc.text(String(text), x + 4, y + (opts.dy ?? 4), {
        width: w - 8, align: opts.align || 'left', lineBreak: false,
      });
    };

    // ── Guest / stay grid ──
    let y = doc.y;
    const rowH = 16;

    cell(L, y, W * 0.55, rowH, 'Folio No.', { bold: true });
    cell(L + W * 0.55, y, W * 0.45, rowH, `Date  :  ${model.meta.date}`, { bold: true });
    doc.font('Helvetica').fontSize(8).text(`:  ${model.meta.folioNumber}`, L + 90, y + 4, { lineBreak: false });
    y += rowH;

    cell(L, y, W, rowH, 'Guest Name', { bold: true });
    doc.font('Helvetica').fontSize(8).text(`:  ${model.meta.guestName}`, L + 90, y + 4, { lineBreak: false });
    y += rowH;

    const q = W / 4;
    for (const [i, [label, value]] of [
      ['Nationality', model.meta.nationality],
      ['No. of Pax', model.meta.pax],
      ['Adult Child', `${model.meta.adults} / ${model.meta.children}`],
      ['G.R. Card No', model.meta.grCardNo],
    ].entries()) {
      cell(L + q * i, y, q, rowH, label, { bold: true, align: i === 0 ? 'left' : 'center' });
      cell(L + q * i, y + rowH, q, rowH, value, { align: i === 0 ? 'left' : 'center' });
    }
    y += rowH * 2;

    const t = W / 3;
    cell(L, y, t, rowH, 'Date of Arrival', { bold: true });
    cell(L + t, y, t, rowH, model.meta.arrival);
    cell(L + t * 2, y, t, rowH, `Tariff   ${money(model.meta.tariffCents)}`, { bold: true });
    y += rowH;
    cell(L, y, t, rowH, 'Date of Departure', { bold: true });
    cell(L + t, y, t, rowH, model.meta.departure);
    cell(L + t * 2, y, t, rowH, '');
    y += rowH;
    cell(L, y, t, rowH, 'Time of Arrival', { bold: true });
    cell(L + t, y, t, rowH, model.meta.arrivalTime);
    cell(L + t * 2, y, t, rowH, '');
    y += rowH + 4;

    // ── Particular / Total header ──
    cell(L, y, SPLIT - L, rowH + 2, 'Particular', { bold: true, size: 10, dy: 5 });
    cell(SPLIT, y, R - SPLIT, rowH + 2, 'Total', { bold: true, size: 10, dy: 5, align: 'right' });
    y += rowH + 2;

    const bodyTop = y;
    const lineH = 13;
    const AMOUNT_COL = SPLIT - 130;

    for (const section of model.sections) {
      doc.font('Helvetica-Bold').fontSize(8.5).text(section.title, L + 4, y + 2, { lineBreak: false });
      y += lineH;
      for (const row of section.rows) {
        doc.font('Helvetica').fontSize(8);
        doc.text(row.label, L + 20, y + 2, { width: 200, lineBreak: false });
        doc.text(money(row.amountCents), AMOUNT_COL, y + 2, { width: 110, align: 'right', lineBreak: false });
        y += lineH;
      }
      // The section subtotal sits in the right-hand rail, as in the reference.
      doc.font('Helvetica').fontSize(8);
      doc.text(money(section.subtotalCents), SPLIT + 4, y - lineH + 2, {
        width: R - SPLIT - 8, align: 'right', lineBreak: false,
      });
      y += 3;
    }

    // Column rules for the body block.
    doc.rect(L, bodyTop, SPLIT - L, y - bodyTop).stroke();
    doc.rect(SPLIT, bodyTop, R - SPLIT, y - bodyTop).stroke();

    // ── Totals rail ──
    for (const [label, value] of [
      ['Total Charges', model.totals.totalChargesCents],
      ['Total Payment', model.totals.totalPaymentCents],
      ['Balance', model.totals.balanceCents],
    ]) {
      cell(SPLIT - 130, y, 130, rowH, label, { bold: true });
      cell(SPLIT, y, R - SPLIT, rowH, money(value), { bold: true, align: 'right' });
      y += rowH;
    }
    y += 4;

    // ── Footer block ──
    cell(L, y, W, rowH, `Remark        :  ${model.footer.remark}`, { bold: true });
    y += rowH;
    cell(L, y, W, rowH, `This Folio is in   :  ${model.footer.currency}`, { bold: true });
    y += rowH;
    cell(L, y, W, rowH, `Bill To               :  ${model.footer.billTo}`, { bold: true });
    y += rowH;
    cell(L, y, W, rowH, `Address             :  ${model.footer.address}`, { bold: true });
    y += rowH;
    cell(L, y, W, rowH, `${model.footer.currency} ${model.footer.amountInWords.toUpperCase()}`);
    y += rowH + 8;

    doc.font('Helvetica').fontSize(7).fillColor('#000');
    doc.text(
      'NOTICE TO GUESTS: This property is privately owned and the management reserves the right to refuse ' +
        'service to anyone. Management will not be responsible for accidents or injury to guests or for loss ' +
        'of money, jewelry or valuables of any kind. Management will not be responsible for any item left in ' +
        'the room.',
      L, y, { width: W, align: 'left' }
    );
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').text('CHECKOUT TIME: 11:00 AM        SELF REGISTRATION ONLY', { width: W });
    doc.font('Helvetica').text(
      'I AGREE that my liability for this bill is not waived and agree to be held personally liable in the ' +
        'event that the indicated person or company failed to pay for any part or full amount of these ' +
        'charges. I agree that if an attorney is retained to collect these charges, I will pay all reasonable ' +
        "attorney's fees and costs incurred. I agree that the sole purpose of renting this room is for my own " +
        'residency only.',
      { width: W, align: 'justify' }
    );

    doc.end();
  } catch (err) {
    console.error('[Folio] Print error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
  }
});
```

Add the imports at the top of the file if absent:

```js
const { folioPrintModel } = require('../lib/folioPrintModel');
```

- [ ] **Step 2: Verify the route still compiles and the suite passes**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/folio" && node -e "require('./src/routes/folio.routes.js')" 2>&1 | head -5; npm test
```

Expected: no require error, all tests PASS including `authz.test.js`.

- [ ] **Step 3: Render a real folio and eyeball it against the reference**

With the stack running and a folio that has charges, payments and tax:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
# Replace <TOKEN> and <FOLIO_ID>; get a token by signing in through the UI and
# copying it out of localStorage, or via POST /api/auth/login.
curl -s -H "Authorization: Bearer <TOKEN>" \
  "http://localhost:8080/api/folios/<FOLIO_ID>/print" -o /tmp/folio.pdf && open /tmp/folio.pdf
```

Compare against `10 - References/FELISMINO-JANA-MARIE_GUEST-FOLIO.pdf`. Check: the section order matches, every section is present even at zero, the right-hand rail shows Total Charges / Total Payment / Balance, and no text overflows its cell. Adjust `SPLIT`, `rowH` or `lineH` if a column crowds.

- [ ] **Step 4: Commit**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
git add services/folio/src/routes/folio.routes.js
git commit -m "$(cat <<'EOF'
feat: render the guest folio to the reference invoice layout

A bordered grid with the hotel identity block, the boxed guest/stay header,
and every section of the reference in order -- room charges, the four room tax
components, extra charges, tax on charges, transfers both ways, flat discount,
amount paid, adjustment -- plus the totals rail and the notice block.

Rendering only; the arithmetic is in lib/folioPrintModel.js and unit tested.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Guest batch lookup

**Files:**
- Modify: `services/guest/src/routes/guest.routes.js`
- Test: `services/guest/src/routes/guestBatch.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `GET /api/guests/batch?ids=a,b,c` → `[{ id, displayName, profileNumber, nationality }]`. Unknown ids are omitted, not nulled. Task 7 consumes this.

- [ ] **Step 1: Write the failing test**

Create `services/guest/src/routes/guestBatch.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const memDb = { guest: new Map() };

const mockPrisma = {
  guest: {
    findMany: async ({ where, select } = {}) => {
      let rows = [...memDb.guest.values()];
      if (where?.id?.in) rows = rows.filter((g) => where.id.in.includes(g.id));
      if (!select) return rows;
      return rows.map((g) => Object.fromEntries(Object.keys(select).map((k) => [k, g[k]])));
    },
    findUnique: async ({ where: { id } }) => memDb.guest.get(id) || null,
    create: async ({ data }) => data,
    update: async ({ data }) => data,
    count: async () => memDb.guest.size,
  },
  guestContact: { findMany: async () => [], create: async ({ data }) => data },
  $transaction: async (fn) => fn(mockPrisma),
};

require.cache[require.resolve('@prisma/client')] = {
  exports: { PrismaClient: function () { return mockPrisma; } },
};
try {
  require.cache[require.resolve('ioredis')] = {
    exports: function () { return { publish: () => {}, on: () => {}, disconnect: () => {} }; },
  };
} catch { /* not installed in this service */ }
require.cache[require.resolve('../middleware/auth')] = {
  exports: {
    ROLE_GROUPS: new Proxy({}, { get: () => ['ADMIN'] }),
    verifyToken: (req, _res, next) => { req.user = { sub: 'u1', roles: ['ADMIN'] }; next(); },
    requireRole: () => (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    JWT_SECRET: 'test-secret-that-is-at-least-32-chars-long',
  },
};

const router = require('./guest.routes');

function call(method, path) {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const req = http.request(
        { host: '127.0.0.1', port: server.address().port, method, path },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); });
        }
      );
      req.end();
    });
  });
}

test('batch returns the named guests', async () => {
  memDb.guest.clear();
  memDb.guest.set('g1', { id: 'g1', displayName: 'Jana Felismino', profileNumber: 'P-1', nationality: 'Filipino' });
  memDb.guest.set('g2', { id: 'g2', displayName: 'Mark Santos', profileNumber: 'P-2', nationality: 'Filipino' });
  memDb.guest.set('g3', { id: 'g3', displayName: 'Unwanted', profileNumber: 'P-3', nationality: null });

  const res = await call('GET', '/api/guests/batch?ids=g1,g2');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.deepEqual(res.body.map((g) => g.id).sort(), ['g1', 'g2']);
  assert.equal(res.body.find((g) => g.id === 'g1').displayName, 'Jana Felismino');
});

// THE ORDERING HAZARD. /guests/:id is declared in this router; if the literal
// path is registered after it, Express matches 'batch' as a guest id and this
// endpoint silently 404s. lib comment on /folios/outstanding documents the same
// trap.
test('batch is not swallowed by the /guests/:id route', async () => {
  memDb.guest.clear();
  const res = await call('GET', '/api/guests/batch?ids=');
  assert.equal(res.status, 200, 'must not be handled as a guest whose id is "batch"');
  assert.deepEqual(res.body, []);
});

test('unknown ids are omitted rather than returned as nulls', async () => {
  memDb.guest.clear();
  memDb.guest.set('g1', { id: 'g1', displayName: 'Jana', profileNumber: 'P-1', nationality: null });
  const res = await call('GET', '/api/guests/batch?ids=g1,nope');
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, 'g1');
});

test('a missing ids param returns an empty list, not every guest in the hotel', async () => {
  memDb.guest.clear();
  memDb.guest.set('g1', { id: 'g1', displayName: 'Jana', profileNumber: 'P-1', nationality: null });
  const res = await call('GET', '/api/guests/batch');
  assert.deepEqual(res.body, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/guest" && node --test src/routes/guestBatch.test.js
```

Expected: FAIL — the batch route does not exist, so requests fall through to `/guests/:id` and 404.

- [ ] **Step 3: Add the route BEFORE `/guests/:id`**

In `services/guest/src/routes/guest.routes.js`, insert immediately **after** the `/guests/search` route (which ends around line 80) and **before** `router.get('/guests/:id', ...)` on line 82:

```js
// GET /api/guests/batch?ids=a,b,c — resolve many guests' display names in one
// call. The folio list renders a guest name per row and would otherwise issue
// one request per row.
//
// MUST be declared BEFORE /guests/:id. Express matches in declaration order, so
// registering it after would make this path match as a guest whose id is the
// literal string 'batch' — the same trap /folios/outstanding documents in the
// folio service.
router.get('/guests/batch', requireRole(...ROLE_GROUPS.DESK), async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // No ids means no guests. Falling through to "every guest" would turn a
    // missing query param into a full PII dump.
    if (ids.length === 0) return res.json([]);
    // Bounded so one caller cannot ask for the whole table in a single request.
    const guests = await prisma.guest.findMany({
      where: { id: { in: ids.slice(0, 200) } },
      select: { id: true, displayName: true, profileNumber: true, nationality: true },
    });
    res.json(guests);
  } catch (err) {
    console.error('[Guest] Batch lookup error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/guest" && npm test
```

Expected: all PASS, including `authz.test.js`.

- [ ] **Step 5: Commit**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
git add services/guest/src/routes/guest.routes.js services/guest/src/routes/guestBatch.test.js
git commit -m "$(cat <<'EOF'
feat: GET /api/guests/batch to resolve many display names in one call

The folio list renders a guest name per row and would otherwise issue one
request per row. Declared before /guests/:id -- registering it after would
make Express match 'batch' as a guest id and silently 404.

A missing ids param returns an empty list, not every guest in the hotel.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Folio list endpoint — search, guest names, balances

**Files:**
- Modify: `services/folio/src/routes/folio.routes.js` (the `GET /folios` route)
- Test: `services/folio/src/lib/folioList.test.js` (create)
- Create: `services/folio/src/lib/folioList.js`

**Interfaces:**
- Consumes: `classifyTransactions`; `GET /api/guests/batch` (Task 6); `GET /api/guests/search` (existing, `guest.routes.js:47`).
- Produces:
  - `folioListRow(folio, { roomCodes, facilityCodes }, guestName)` → `{ id, folioNumber, status, currency, stayId, guestId, guestName, balanceCents, openedAt }` with `balanceCents` a **decimal string** (JSON has no BigInt).
  - `GET /api/folios?q=&status=&stayId=&guestId=` → an array of those rows.

- [ ] **Step 1: Write the failing test**

Create `services/folio/src/lib/folioList.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { folioListRow } = require('./folioList');

const CODES = { roomCodes: new Set(['RM']), facilityCodes: new Set(['POOL']) };

test('the row balance matches the classifier the bill is computed from', () => {
  const row = folioListRow(
    {
      id: 'f1', folioNumber: 'F-00011', status: 'OPEN', currency: 'PHP',
      stayId: 's1', guestId: 'g1', openedAt: new Date('2026-09-01T00:00:00.000Z'),
      transactions: [
        { type: 'CHARGE', chargeCode: 'RM', amountCents: 2535000n, taxAmountCents: 557700n },
        { type: 'PAYMENT', chargeCode: null, amountCents: 100000n, taxAmountCents: 0n },
      ],
    },
    CODES,
    'Jana Felismino'
  );
  assert.equal(row.folioNumber, 'F-00011');
  assert.equal(row.guestName, 'Jana Felismino');
  // 25,350.00 + 5,577.00 tax - 1,000.00 paid = 29,927.00
  assert.equal(row.balanceCents, '2992700');
});

test('balanceCents is a string, because JSON cannot carry BigInt', () => {
  const row = folioListRow(
    { id: 'f1', folioNumber: 'F-1', status: 'OPEN', currency: 'PHP', transactions: [] },
    CODES, null
  );
  assert.equal(typeof row.balanceCents, 'string');
  assert.equal(row.balanceCents, '0');
});

test('an unresolved guest name degrades to null rather than failing the row', () => {
  // The list must still render when the guest service is unreachable -- a folio
  // list that 500s because a NAME could not be fetched is a worse regression
  // than the missing search it replaces.
  const row = folioListRow(
    { id: 'f1', folioNumber: 'F-1', status: 'OPEN', currency: 'PHP', transactions: [] },
    CODES, undefined
  );
  assert.equal(row.guestName, null);
  assert.equal(row.folioNumber, 'F-1');
});

test('the transactions array is not leaked into the row', () => {
  const row = folioListRow(
    { id: 'f1', folioNumber: 'F-1', status: 'OPEN', currency: 'PHP',
      transactions: [{ type: 'CHARGE', chargeCode: 'RM', amountCents: 100n, taxAmountCents: 0n }] },
    CODES, null
  );
  assert.equal(row.transactions, undefined, 'a list row must not carry a full ledger');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/folio" && node --test src/lib/folioList.test.js
```

Expected: FAIL — `Cannot find module './folioList'`.

- [ ] **Step 3: Create the row builder**

Create `services/folio/src/lib/folioList.js`:

```js
// One row of the folio list.
//
// The balance uses classifyTransactions -- the same classifier the printed folio
// and the check-out guard use -- so the number in the list is the number on the
// bill, not a second subtly different sum.

const { classifyTransactions } = require('./folioSummary');

function folioListRow(folio, codes, guestName) {
  const summary = classifyTransactions(folio.transactions || [], codes);
  return {
    id: folio.id,
    folioNumber: folio.folioNumber,
    status: folio.status,
    currency: folio.currency,
    stayId: folio.stayId ?? null,
    guestId: folio.guestId ?? null,
    // null, not '—': the row is data, and the dash is the frontend's choice.
    guestName: guestName ?? null,
    // JSON cannot carry BigInt.
    balanceCents: summary.balanceCents.toString(),
    openedAt: folio.openedAt,
  };
}

module.exports = { folioListRow };
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/folio" && node --test src/lib/folioList.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Rewrite the list route**

In `services/folio/src/routes/folio.routes.js`, replace the `GET /folios` route with:

```js
// GET /api/folios?q=&status=&stayId=&guestId=
//
// `q` matches two ways, unioned: the folio number in this service's own
// database, and any folio whose guest the guest service matches by name. The
// Folios screen used to demand a raw UUID, so a folio could not be found
// without already knowing its id.
router.get('/folios', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const { stayId, guestId, status, q } = req.query;
    const where = {};
    if (stayId) where.stayId = stayId;
    if (guestId) where.guestId = guestId;
    if (status) where.status = status;

    const term = String(q || '').trim();
    if (term) {
      // Guest-name matches come from the guest service; a failure there narrows
      // the search to folio numbers rather than failing it.
      const matches = await fetchJsonOrNull(
        `${GUEST_URL}/api/guests/search?q=${encodeURIComponent(term)}`
      );
      const guestIds = (matches || []).map((g) => g.id).filter(Boolean);
      where.OR = [
        { folioNumber: { contains: term, mode: 'insensitive' } },
        ...(guestIds.length ? [{ guestId: { in: guestIds } }] : []),
      ];
    }

    const folios = await prisma.folio.findMany({
      where,
      orderBy: { openedAt: 'desc' },
      take: 100,
      include: { transactions: true },
    });

    const codeRows = await prisma.chargeCode.findMany({
      where: { category: { in: ['ROOM', 'FACILITY'] } },
      select: { code: true, category: true },
    });
    const codes = {
      roomCodes: new Set(codeRows.filter((c) => c.category === 'ROOM').map((c) => c.code)),
      facilityCodes: new Set(codeRows.filter((c) => c.category === 'FACILITY').map((c) => c.code)),
    };

    // One batched lookup for every name on the page, not one per row. If the
    // guest service is unreachable the rows still render with a null name --
    // failing the whole list because a NAME could not be fetched would be worse
    // than the missing search this replaces.
    const ids = [...new Set(folios.map((f) => f.guestId).filter(Boolean))];
    const names = new Map();
    if (ids.length) {
      // fetchJsonOrNull returns null rather than throwing on any failure, which
      // is exactly the degradation this list wants.
      const guests = await fetchJsonOrNull(
        `${GUEST_URL}/api/guests/batch?ids=${encodeURIComponent(ids.join(','))}`
      );
      for (const g of guests || []) names.set(g.id, g.displayName);
    }

    res.json(folios.map((f) => folioListRow(f, codes, names.get(f.guestId))));
  } catch (err) {
    console.error('[Folio] List folios error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});
```

Add the import near the other `lib/` requires at the top of the file:

```js
const { folioListRow } = require('../lib/folioList');
```

No new service caller is needed. `fetchJsonOrNull` and `GUEST_URL` are already declared in this file (`folio.routes.js:22` and the helper the print route uses); `fetchJsonOrNull` signs with a service token and returns `null` on any failure, which is precisely the degradation this list wants. Confirm both are present:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
grep -n "GUEST_URL =\|function fetchJsonOrNull" services/folio/src/routes/folio.routes.js
```

Expected: one hit each.

- [ ] **Step 6: Run the folio suite**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/services/folio" && npm test
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
git add services/folio/src/lib/folioList.js services/folio/src/lib/folioList.test.js \
        services/folio/src/routes/folio.routes.js
git commit -m "$(cat <<'EOF'
feat: searchable folio list with guest names and balances

GET /api/folios gains ?q=, matching folio numbers locally and guest names via
the guest service, and returns a balance per row computed with the same
classifier the printed bill uses.

Names resolve in one batched call. If the guest service is unreachable the
rows still render with a null name -- failing a folio list because a NAME
could not be fetched would be worse than the missing search it replaces.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Folios page — the guest-profile layout

**Files:**
- Modify: `web/src/pages/Folios.jsx`

**Interfaces:**
- Consumes: `GET /api/folios?q=` (Task 7).
- Produces: nothing consumed elsewhere.

The existing folio card, transaction table, payments table and the three posting forms are **kept exactly as they are**. Only the "Open a folio" panel is replaced.

- [ ] **Step 1: Add list state and imports**

At the top of `web/src/pages/Folios.jsx`, add to the imports:

```jsx
import { useRef } from 'react';
import EmptyState from '../components/EmptyState';
import Avatar from '../components/Avatar';
```

Merge `useRef` into the existing `react` import rather than adding a second one. Then add state beside the existing `useState` calls:

```jsx
  // The folio list, mirroring the Guest Profiles pattern:
  //   browse      resting state — the most recent folios
  //   suggesting  live matches for what is being typed, still as table rows
  //   selected    a folio was chosen: the list is GONE, not narrowed to one row
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [listMode, setListMode] = useState('browse');
  const [searching, setSearching] = useState(false);
  // Debounce timer plus a monotonic request id: without the id a slow response
  // for "F-1" can land after a fast one for "F-11" and repopulate the table with
  // the wider result.
  const suggestTimer = useRef(null);
  const suggestSeq = useRef(0);
```

- [ ] **Step 2: Add the search functions**

Add these alongside the existing handlers:

```jsx
  useEffect(() => () => clearTimeout(suggestTimer.current), []);

  // `term` is passed explicitly rather than read from `q`: state here reads one
  // render stale, which is what makes a just-created row fail to appear.
  async function searchFolios(term = q, mode) {
    const mine = ++suggestSeq.current;
    setSearching(true);
    try {
      const { data } = await api.get(`/api/folios?q=${encodeURIComponent(term ?? '')}`);
      if (mine !== suggestSeq.current) return;
      setResults(Array.isArray(data) ? data : []);
      if (mode) setListMode(mode);
    } catch (e) {
      if (mine === suggestSeq.current) toast.error(errMsg(e));
    } finally {
      if (mine === suggestSeq.current) setSearching(false);
    }
  }

  function onQueryChange(v) {
    setQ(v);
    clearTimeout(suggestTimer.current);
    const term = v.trim();
    if (!term) {
      setListMode('browse');
      searchFolios('', 'browse');
      return;
    }
    setListMode('suggesting');
    suggestTimer.current = setTimeout(() => searchFolios(term, 'suggesting'), 220);
  }

  // A single match IS the answer, so it opens straight through rather than
  // making you click the one row it just found.
  async function onSearchSubmit(e) {
    e?.preventDefault();
    clearTimeout(suggestTimer.current);
    const term = q.trim();
    if (!term) return searchFolios('', 'browse');
    const mine = ++suggestSeq.current;
    setSearching(true);
    try {
      const { data } = await api.get(`/api/folios?q=${encodeURIComponent(term)}`);
      if (mine !== suggestSeq.current) return;
      setSearching(false);
      const rows = Array.isArray(data) ? data : [];
      setResults(rows);
      if (rows.length === 1) pickFolio(rows[0]);
      else setListMode('suggesting');
    } catch (e) {
      if (mine !== suggestSeq.current) return;
      setSearching(false);
      toast.error(errMsg(e));
    }
  }

  function pickFolio(f) {
    clearTimeout(suggestTimer.current);
    // Bump the sequence so a debounced response still in flight cannot land
    // afterwards and put the list back over the selection.
    suggestSeq.current++;
    setQ(f.folioNumber || '');
    setResults([f]);
    setListMode('selected');
    load(f.id);
  }

  function clearFolioSearch() {
    clearTimeout(suggestTimer.current);
    setQ('');
    setListMode('browse');
    searchFolios('', 'browse');
  }

  // Populate the list on first render.
  useEffect(() => {
    searchFolios('', 'browse');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 3: Keep the `?id=` deep link working**

The existing effect that reads `searchParams.get('id')` stays. Extend it so an incoming deep link also puts the page in `selected` mode, so the Arrivals page's "Folio" button does not land on a list:

```jsx
  useEffect(() => {
    const qid = searchParams.get('id');
    if (qid) {
      load(qid);
      setListMode('selected');
    }
  }, [searchParams]);
```

- [ ] **Step 4: Replace the "Open a folio" panel**

Replace the whole `<div className="panel">` containing `<h3>Open a folio</h3>` with:

```jsx
      <div className="panel">
        {/* No heading once a folio is chosen — a label over a lone search box,
            with the answer in a card below, would be labelling a list that is
            no longer there. */}
        {listMode !== 'selected' && (
          <div className="panel-head" style={{ marginBottom: 12 }}>
            <h3>{listMode === 'browse' ? 'Recent folios' : 'Matching folios'}</h3>
            {searching && (
              <span className="muted" style={{ fontSize: 12 }}>
                <span className="spinner" /> Searching…
              </span>
            )}
          </div>
        )}

        <div className="guest-search-bar">
          <input
            className="guest-search-input"
            value={q}
            placeholder="Folio number or guest name"
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSearchSubmit(e);
              if (e.key === 'Escape') clearFolioSearch();
            }}
            autoComplete="off"
            aria-label="Search folios by number or guest name"
          />
          <button type="button" onClick={onSearchSubmit}>
            Search
          </button>
          {(q || listMode !== 'browse') && (
            <button type="button" className="secondary" onClick={clearFolioSearch}>
              Show all
            </button>
          )}
        </div>

        {listMode === 'selected' ? null : results.length === 0 ? (
          <EmptyState
            kind="search"
            title="No folios found"
            hint={
              q
                ? `No matches for "${q}". Try a folio number or the guest's name.`
                : 'Folios open automatically when a guest checks in.'
            }
          />
        ) : (
          <>
            {listMode !== 'browse' && (
              <div className="guest-isolated-bar">
                <span>
                  {results.length === 1 ? '1 match' : `${results.length} matches`} for “{q}” — choose
                  one, or press Enter.
                </span>
                <button type="button" className="small secondary" onClick={clearFolioSearch}>
                  Show all folios
                </button>
              </div>
            )}
            <table className="table-clickable">
              <thead>
                <tr>
                  <th className="t-c"></th>
                  <th>Folio #</th>
                  <th>Guest</th>
                  <th className="t-c">Status</th>
                  <th style={{ textAlign: 'right' }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {/* The whole row is the control. role/tabIndex/onKeyDown are what
                    keep it usable without a mouse — a bare onClick on a <tr> is
                    invisible to the keyboard and to a screen reader. */}
                {results.map((f) => (
                  <tr
                    key={f.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open folio ${f.folioNumber}`}
                    onClick={() => pickFolio(f)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        pickFolio(f);
                      }
                    }}
                  >
                    <td className="t-c" style={{ width: 40 }}>
                      <Avatar name={f.guestName || 'Folio'} size={32} />
                    </td>
                    <td>{f.folioNumber}</td>
                    <td>{f.guestName || <span className="muted">—</span>}</td>
                    <td className="t-c">
                      <span className={`badge ${String(f.status).toLowerCase()}`}>{f.status}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {formatPeso(f.balanceCents, { currency: f.currency })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
```

- [ ] **Step 5: Move the folio actions onto the folio card**

The Print / Close / Split-bill buttons lived in the deleted panel. Add them to the existing folio card's heading — find `<h3>Folio {folio.folioNumber} · ...</h3>` and wrap it:

```jsx
            <div className="panel-head">
              <h3 style={{ margin: 0 }}>
                Folio {folio.folioNumber} ·{' '}
                <span className={`badge ${folio.status.toLowerCase()}`}>{folio.status}</span>
              </h3>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="secondary" onClick={printPdf}>
                  Print PDF
                </button>
                {folio.status === 'OPEN' && folio.stayId && (
                  <button className="secondary" onClick={addFolio}>
                    Split bill — add folio
                  </button>
                )}
                {folio.status === 'OPEN' && (
                  <button className="danger" onClick={closeFolio}>
                    Close folio
                  </button>
                )}
              </div>
            </div>
```

Keep the split-bill hint paragraph; move it directly under this header.

- [ ] **Step 6: Build the frontend**

Run:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/web" && npm run build
```

Expected: build succeeds. If it complains about a duplicate `react` import, merge the `useRef` import into the existing line rather than adding a second.

- [ ] **Step 7: Commit**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
git add web/src/pages/Folios.jsx
git commit -m "$(cat <<'EOF'
feat: searchable folio list on the guest-profile layout

Replaces the raw folio-id box, which required knowing a UUID before a folio
could be opened. Reuses the Guest Profiles pattern: debounced search with a
monotonic request id, browse/suggesting/selected modes, and the whole row as a
keyboard-reachable control.

The folio card, ledger, payments table and posting forms are unchanged; the
Print/Close/Split actions move onto the card's header.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Settings — tax rates and hotel identity cards

**Files:**
- Modify: `web/src/pages/Settings.jsx`

**Interfaces:**
- Consumes: `GET`/`PUT /api/settings/tax-rates` and `GET`/`PUT /api/settings/hotel` (Task 2).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Add state and loaders**

In `web/src/pages/Settings.jsx`, add beside the existing state:

```jsx
  const [taxRates, setTaxRates] = useState({ vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 });
  const [hotel, setHotel] = useState({ name: '', address: '', phone: '', fax: '', email: '', url: '' });

  useEffect(() => {
    api.get('/api/settings/tax-rates').then((r) => setTaxRates(r.data)).catch(() => {});
    api.get('/api/settings/hotel').then((r) => setHotel(r.data)).catch(() => {});
  }, []);
```

- [ ] **Step 2: Add the save handlers**

```jsx
  async function saveTaxRates(e) {
    e.preventDefault();
    setBusy('tax');
    try {
      const { data } = await api.put('/api/settings/tax-rates', {
        vat: Number(taxRates.vat),
        serviceCharge: Number(taxRates.serviceCharge),
        localTax: Number(taxRates.localTax),
        realPropertyTax: Number(taxRates.realPropertyTax),
      });
      setTaxRates(data);
      toast.success('Tax rates saved. They apply to charges posted from now on.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveHotel(e) {
    e.preventDefault();
    setBusy('hotel');
    try {
      const { data } = await api.put('/api/settings/hotel', hotel);
      setHotel(data);
      toast.success('Hotel details saved.');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(null);
    }
  }
```

- [ ] **Step 3: Add the cards**

Insert after the System Appearance section, following the existing `set-card` markup exactly:

```jsx
      <div className="set-section-label">Billing</div>

      <form className="set-card is-wide" onSubmit={saveTaxRates}>
        <div className="set-card-head">
          <span className="set-card-icon">
            <Icon name="percent" size={16} strokeWidth={1.9} />
          </span>
          <div className="set-card-heading">
            <div className="set-card-title">Tax Rates</div>
            <div className="set-card-sub">
              Applied to charges as they are posted. Existing charges keep the rates they
              were posted with.
            </div>
          </div>
        </div>
        <div className="set-card-body">
          <div className="set-row-3">
            {[
              ['vat', 'VAT (%)'],
              ['serviceCharge', 'Service Charge (%)'],
              ['localTax', 'Local Tax (%)'],
              ['realPropertyTax', 'Real Property Tax (%)'],
            ].map(([key, label]) => (
              <Field key={key} label={label}>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={taxRates[key]}
                  onChange={(e) => setTaxRates({ ...taxRates, [key]: e.target.value })}
                />
              </Field>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            Local Tax and Real Property Tax ship at 0% — they vary by locality, so set them
            to this property&rsquo;s actual rates before billing guests.
          </p>
        </div>
        <div className="set-card-foot">
          <button type="submit" className="btn-primary" disabled={busy === 'tax'}>
            {busy === 'tax' ? 'Saving…' : 'Save Rates'}
          </button>
        </div>
      </form>

      <form className="set-card is-wide" onSubmit={saveHotel}>
        <div className="set-card-head">
          <span className="set-card-icon">
            <Icon name="building" size={16} strokeWidth={1.9} />
          </span>
          <div className="set-card-heading">
            <div className="set-card-title">Hotel Details</div>
            <div className="set-card-sub">Printed at the top of every guest folio.</div>
          </div>
        </div>
        <div className="set-card-body">
          <div className="set-row-3">
            {[
              ['name', 'Hotel name'],
              ['address', 'Address'],
              ['phone', 'Phone'],
              ['fax', 'Fax'],
              ['email', 'E-mail'],
              ['url', 'Website'],
            ].map(([key, label]) => (
              <Field key={key} label={label}>
                <input
                  value={hotel[key] || ''}
                  maxLength={200}
                  onChange={(e) => setHotel({ ...hotel, [key]: e.target.value })}
                />
              </Field>
            ))}
          </div>
        </div>
        <div className="set-card-foot">
          <button type="submit" className="btn-primary" disabled={busy === 'hotel'}>
            {busy === 'hotel' ? 'Saving…' : 'Save Details'}
          </button>
        </div>
      </form>
```

Confirm the two icon names exist before using them:

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS" && grep -n "percent\|building" web/src/components/Icon.jsx | head
```

If either is missing, substitute a name the component defines (e.g. `settings` or `bed`) rather than rendering a blank glyph.

- [ ] **Step 4: Build and commit**

```bash
cd "/Users/arymsr.vendiola/Documents/InnSight PMS/web" && npm run build
cd "/Users/arymsr.vendiola/Documents/InnSight PMS"
git add web/src/pages/Settings.jsx
git commit -m "$(cat <<'EOF'
feat: Settings cards for tax rates and hotel details

Tax rates drive the four components itemised on a printed folio. The card says
out loud that Local Tax and RPT ship at 0% and must be set to the property's
real rates -- they vary by locality and were deliberately not invented.

Hotel details fill the folio header block, which defaults to InnSight rather
than to any real property.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Manual verification

Bring the stack up, **rebuilding the gateway** (`docker compose up -d --build`), and run migrations (`bash scripts/db-init.sh`).

1. **Tax is no longer zero.** Open a folio, post a ₱25,350.00 room charge. The ledger shows ₱5,577.00 tax (12% + 10%). Before this work it was ₱0.00.
2. **Settings reach the folio service.** Settings → Billing → Tax Rates loads and saves. Confirm `/api/settings/theme` still works — that proves the longer-prefix gateway locations did not swallow the reservation service's routes.
3. **Set a local tax.** Set Local Tax to 1.85%, post another room charge, print. The Local Tax row is non-zero on the new charge and zero on the old one — rates are not retroactive.
4. **Print matches the reference.** Print the folio and compare against `FELISMINO-JANA-MARIE_GUEST-FOLIO.pdf`: bordered grid, hotel header, boxed guest block, all nine sections present even at zero, four named tax components, the Total Charges / Total Payment / Balance rail, amount in words, notice and agreement footer.
5. **Historical folios are unmoved.** Print a folio created before this work. It must render, show its whole tax on the VAT line, and show **the same balance it showed before**. Compare against a screenshot taken before starting.
6. **Folio search.** The Folios page opens on a list of recent folios. Type a guest surname — rows narrow. Type a folio number — it narrows to one and opens straight through. Click a row; the list disappears and the ledger card appears.
7. **Deep link.** From Arrivals, check a guest in and click Folio. It must open that folio directly, not a list.
8. **Guest service down.** `docker compose stop guest-service`, reload Folios. Rows still render with a dash for the name — no error, no blank page.
