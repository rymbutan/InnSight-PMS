// Route-level tests for GET /api/folios/:id/print — specifically PAGINATION.
//
// THE BUG THIS FILE EXISTS FOR
// ----------------------------
// The renderer draws at ABSOLUTE coordinates and advances its own `y`. pdfkit
// adds a page by itself the moment a draw crosses the bottom margin, but it
// resets only ITS cursor — the route's `y` kept climbing, so every following
// draw spilled again. The result was a cascade, not pagination: measured on
// this exact fixture, 10 adjustment rows produced 5 pages, 20 produced 20 and
// 40 produced 60. A guest with a long bill got a ream of near-empty paper.
//
// These tests render the real handler and count PDF page objects. They are
// deliberately coarse (an upper bound per row count, not an exact figure) so
// that a legitimate tweak to a font size or a row height does not break them,
// while any return of the cascade does — 40 rows can never fit in an upper
// bound of 4 pages if each row is costing a page and a half.
//
//   node --test src/routes/folioPrint.test.js

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const zlib = require('node:zlib');

BigInt.prototype.toJSON = function () {
  return this.toString();
};

// ── In-memory store ─────────────────────────────────────────────────────────

let folioRow = null;

const mockPrisma = {
  folio: { findUnique: async () => folioRow, findMany: async () => [] },
  chargeCode: {
    findMany: async () => [
      { code: 'RM', category: 'ROOM' },
      { code: 'SPA', category: 'FACILITY' },
    ],
    findUnique: async () => null,
  },
  folioTransaction: { create: async ({ data }) => ({ id: 'x', ...data }) },
  appSetting: { findMany: async () => [] },
};

// ── Stubs, installed before the route module loads ──────────────────────────

require.cache[require.resolve('@prisma/client')] = {
  exports: { PrismaClient: function () { return mockPrisma; } },
};
require.cache[require.resolve('ioredis')] = {
  exports: function () { return { publish: () => {}, on: () => {}, disconnect: () => {} }; },
};
require.cache[require.resolve('../middleware/auth')] = {
  exports: {
    ROLE_GROUPS: new Proxy({}, { get: () => ['ADMIN'] }),
    requireRole: () => (req, _res, next) => {
      req.user = { sub: 'u1', username: 'tester', roles: ['ADMIN'] };
      next();
    },
    signServiceToken: () => 'test-token',
  },
};

// A FULLY POPULATED hotel identity on purpose. The header's address/phone/URL
// lines are three of the tightest points in the layout: a dev database with no
// hotel configured prints a shorter header and would hide a regression that a
// real, configured property would hit.
require.cache[require.resolve('../lib/settingsStore')] = {
  exports: {
    getTaxRates: async () => ({ vat: 12, serviceCharge: 10, localTax: 0, realPropertyTax: 0 }),
    getHotel: async () => ({
      name: 'Aureliscita Grande Hotel',
      address: '123 Real Street, Lucban, Quezon',
      phone: '+63 42 000 0000',
      fax: '+63 42 000 0001',
      email: 'front@example.test',
      url: 'https://example.test',
    }),
    saveTaxRates: async () => {},
    saveHotel: async () => {},
  },
};

const router = require('./folio.routes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

function getPdf(path) {
  return new Promise((resolve, reject) => {
    const server = makeApp().listen(0, () => {
      const req = http.request(
        { host: '127.0.0.1', port: server.address().port, method: 'GET', path },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  });
}

// pdfkit writes "/Type /Page" once per page and "/Type /Pages" for the page
// tree, so the negative lookahead is what separates the two.
function pageCount(buf) {
  return (buf.toString('latin1').match(/\/Type \/Page(?![s])/g) || []).length;
}

// pdfkit deflates its content streams AND writes the drawn strings as
// hex-encoded WinAnsi inside TJ arrays, so nothing is searchable in the raw
// bytes. Inflate every stream, then rebuild one line per BT..ET text block by
// concatenating that block's hex chunks (the numbers between them are kerning).
// Per-block, not one big string, so a substring can never be manufactured by
// two unrelated draws sitting next to each other.
function text(buf) {
  const raw = buf.toString('latin1');
  let content = '';
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      content += zlib.inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
    } catch {
      // Not a deflated stream (fonts, metadata) — nothing to read here.
    }
  }
  return content
    .split('ET')
    .map((block) =>
      (block.match(/<([0-9a-fA-F]+)>/g) || [])
        .map((h) => Buffer.from(h.slice(1, -1), 'hex').toString('latin1'))
        .join('')
    )
    .join('\n');
}

const POSTED = new Date('2026-09-01T10:00:00.000Z');

function folioWith(txs) {
  return {
    id: 'f1',
    folioNumber: 'F-0001',
    currency: 'PHP',
    status: 'OPEN',
    stayId: null,
    guestId: null,
    transactions: txs,
  };
}

const ROOM_CHARGE = {
  id: 'c0', type: 'CHARGE', chargeCode: 'RM', description: 'Room Charge',
  amountCents: 500000n, taxAmountCents: 110000n, taxBreakdown: null, postedAt: POSTED,
};

// N free-text ADJUSTMENT rows — each one adds a row to the Adjustment section.
function adjustments(n) {
  const txs = [ROOM_CHARGE];
  for (let i = 0; i < n; i += 1) {
    txs.push({
      id: `a${i}`, type: 'ADJUSTMENT', chargeCode: null,
      description: `Adjustment line ${i + 1}`,
      amountCents: BigInt(1000 + i), taxAmountCents: 0n, taxBreakdown: null, postedAt: POSTED,
    });
  }
  return folioWith(txs);
}

// N transfer PAIRS — the split-bill case, and the worse one: each pair adds a
// row to "Transferred From Folio" AND a row to "Transferred To Folio".
function transferPairs(n) {
  const txs = [ROOM_CHARGE];
  for (let i = 0; i < n; i += 1) {
    txs.push({
      id: `ti${i}`, type: 'TRANSFER', chargeCode: 'SPA',
      description: `Spa — transferred from folio F-100${i}`,
      amountCents: BigInt(20000 + i), taxAmountCents: 0n, taxBreakdown: null, postedAt: POSTED,
    });
    txs.push({
      id: `to${i}`, type: 'TRANSFER', chargeCode: 'SPA',
      description: `Spa — transferred to folio F-200${i}`,
      amountCents: BigInt(-(20000 + i)), taxAmountCents: 0n, taxBreakdown: null, postedAt: POSTED,
    });
  }
  return folioWith(txs);
}

// ── The regression gate ─────────────────────────────────────────────────────

test('a folio with no extra rows still prints on ONE page', async () => {
  folioRow = adjustments(0);
  const res = await getPdf('/api/folios/f1/print');
  assert.equal(res.status, 200);
  assert.equal(
    pageCount(res.buf), 1,
    'the empty/typical folio must not have grown a second sheet'
  );
});

test('page count grows roughly linearly, never as a cascade', async () => {
  // Upper bounds, not exact counts. Before the fix these measured 5 / 20 / 60.
  for (const [rows, maxPages] of [[10, 2], [20, 2], [40, 3], [100, 4], [200, 6]]) {
    folioRow = adjustments(rows);
    const res = await getPdf('/api/folios/f1/print');
    const pages = pageCount(res.buf);
    assert.ok(
      pages <= maxPages,
      `${rows} adjustment rows produced ${pages} pages, expected at most ${maxPages}`
    );
  }
});

test('split bills paginate too — a transfer pair adds a row to TWO sections', async () => {
  // Before the fix: 5 pairs -> 4 pages, 10 pairs -> 16 pages.
  for (const [pairs, maxPages] of [[5, 2], [10, 2], [40, 4]]) {
    folioRow = transferPairs(pairs);
    const res = await getPdf('/api/folios/f1/print');
    const pages = pageCount(res.buf);
    assert.ok(
      pages <= maxPages,
      `${pairs} transfer pairs produced ${pages} pages, expected at most ${maxPages}`
    );
  }
});

// ── What pagination must not break ──────────────────────────────────────────

test('all nine sections still appear, in the reference order, even at zero', async () => {
  folioRow = folioWith([]);
  const res = await getPdf('/api/folios/f1/print');
  const body = text(res.buf);
  const order = [
    'Room Charges',
    'Add : Room Tax',
    'Add : Extra Charges',
    'Add : Tax On Charges',
    'Add : Transferred From Folio',
    'Less : Flat Discount',
    'Less : Amount Paid',
    'Less : Transferred To Folio',
    'Adjustment',
  ];
  let cursor = -1;
  for (const title of order) {
    const at = body.indexOf(title, cursor + 1);
    assert.ok(at > cursor, `section "${title}" is missing or out of order`);
    cursor = at;
  }
});

test('a continuation page names the folio and says it is a continuation', async () => {
  folioRow = adjustments(60);
  const res = await getPdf('/api/folios/f1/print');
  assert.ok(pageCount(res.buf) > 1, 'this fixture must actually spill for the test to mean anything');
  const body = text(res.buf);
  assert.ok(body.includes('continued'), 'loose pages of one bill must be identifiable');
  // The folio number appears on the front sheet too; a continuation banner is
  // an ADDITIONAL occurrence.
  assert.ok(
    (body.match(/F-0001/g) || []).length >= 2,
    'the folio number must be repeated on the continuation page'
  );
});

test('a section that runs over a page repeats its heading — no orphaned rows', async () => {
  folioRow = adjustments(60);
  const res = await getPdf('/api/folios/f1/print');
  assert.ok(
    text(res.buf).includes('Adjustment (continued)'),
    'a row must never be separated from the section heading it belongs under'
  );
});

test('the totals rail is present and whole at every row count', async () => {
  // Rendered at several lengths so the rail lands in a different position each
  // time; it must never be broken up, whatever the row count.
  for (const rows of [0, 1, 2, 5, 17, 18, 19, 40, 61]) {
    folioRow = adjustments(rows);
    const res = await getPdf('/api/folios/f1/print');
    const body = text(res.buf);
    for (const label of ['Total Charges', 'Total Payment', 'Balance']) {
      assert.ok(body.includes(label), `"${label}" missing at ${rows} rows`);
    }
  }
});

// ── The contract the route must not lose while being repaginated ────────────

test('the route keeps its inline PDF disposition', async () => {
  folioRow = adjustments(0);
  const res = await getPdf('/api/folios/f1/print');
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.headers['content-disposition'], 'inline; filename="folio-F-0001.pdf"');
});
