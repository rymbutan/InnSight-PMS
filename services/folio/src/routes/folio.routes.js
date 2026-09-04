const express = require('express');
const PDFDocument = require('pdfkit');
const Redis = require('ioredis');
const { requireRole, ROLE_GROUPS, signServiceToken } = require('../middleware/auth');
const { centsToWords } = require('../lib/receiptWords');
const { classifyTransactions } = require('../lib/folioSummary');
const { buildLaundryTicket } = require('../lib/laundryTicket');
const { planTransfer } = require('../lib/transfer');

const ADMIN = ['ADMIN', 'MANAGER'];
const FINANCE = ['ADMIN', 'MANAGER', 'AUDITOR'];
// Front-desk cashiering: open folios and post charges/payments/deposits.
// (ADMIN is included so the night-audit service token can post room charges.)
const CASHIER = ['ADMIN', 'MANAGER', 'FRONT_DESK'];

const INVENTORY_URL = process.env.INVENTORY_URL || 'http://inventory-service:3005';
const GUEST_URL = process.env.GUEST_URL || 'http://guest-service:3008';
const STAY_URL = process.env.STAY_URL || 'http://stay-service:3006';
const RESERVATION_URL = process.env.RESERVATION_URL || 'http://reservation-service:3011';
const SERVICE_TIMEOUT_MS = Number(process.env.SERVICE_TIMEOUT_MS || 8000);
// Short-lived service token for looking up authoritative facility pricing.
function serviceToken() {
  // Was signed with the human JWT_SECRET and asserted a blanket ADMIN role. Now a
  // separate service key, and only the permission it actually uses (reading a
  // facility's price and linking a booking).
  return signServiceToken({
    name: 'folio',
    roles: ['MANAGER'],
    permissions: ['room.read', 'rateplan.read', 'guest.read', 'stay.read', 'reservation.read'],
    expiresIn: '2m',
  });
}
// Best-effort cross-service GET. A failed lookup returns null instead of
// throwing — the print route degrades a field to "—" rather than failing the
// whole print, since staff need folios to print during an audit even if
// another service is degraded.
async function fetchJsonOrNull(url) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${serviceToken()}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
// Authoritative facility total (mirrors inventory's facilityTotalCents).
function facilityTotalCents(f, { units, persons, startAt, endAt } = {}) {
  const p = f.priceCents;
  if (f.pricingModel === 'PER_HOUR') {
    const hrs =
      startAt && endAt
        ? Math.max(1, Math.ceil((new Date(endAt) - new Date(startAt)) / 3600000))
        : Math.max(1, units || 1);
    return p * hrs;
  }
  if (f.pricingModel === 'PER_DAY') {
    const days =
      startAt && endAt
        ? Math.max(1, Math.ceil((new Date(endAt) - new Date(startAt)) / 86400000))
        : Math.max(1, units || 1);
    return p * days;
  }
  if (f.pricingModel === 'PER_PERSON') return p * Math.max(1, persons || units || 1);
  return p * Math.max(1, units || 1);
}

const router = express.Router();
const prisma = require('../lib/prisma');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
redis.on('error', (e) => console.error('[Folio] redis error:', e.message));

function nextFolioNumber() {
  return `F-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

// Parse a cents amount from request input. Accepts a non-negative integer
// number or all-digit string; returns a BigInt, or null if invalid. Callers
// return HTTP 400 on null instead of letting BigInt() throw a 500 on e.g.
// "10.5" or "abc".
function parseCents(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

// POST /api/folios
router.post('/folios', requireRole(...CASHIER), async (req, res) => {
  try {
    const { stayId, guestId, type, currency } = req.body;
    const folio = await prisma.folio.create({
      data: {
        folioNumber: nextFolioNumber(),
        stayId,
        guestId,
        type: type || 'GUEST',
        currency: currency || 'PHP',
      },
    });
    redis.publish('folio:opened', JSON.stringify({ folioId: folio.id, stayId, guestId }));
    res.status(201).json(folio);
  } catch (err) {
    console.error('[Folio] Create folio error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/folios/amenity-sale — one-click walk-in amenity/facility sale (POS).
// Verifies the facility price server-side from inventory, then opens a WALKIN
// folio, posts the charge + full payment, and closes it — all atomically.
router.post('/folios/amenity-sale', requireRole(...CASHIER), async (req, res) => {
  try {
    const { facilityCode, guestName, units, persons, startAt, endAt, method, facilityBookingId } = req.body;
    if (!facilityCode || !method) return res.status(400).json({ error: 'facilityCode and method required.' });

    // Authoritative pricing — never trust a client-supplied amount.
    let f;
    try {
      // Bounded: Node's global fetch has no default timeout, so a wedged inventory
      // service would hang this sale indefinitely instead of failing it.
      const r = await fetch(`${INVENTORY_URL}/api/facilities/${encodeURIComponent(facilityCode)}`, {
        signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${serviceToken()}` },
      });
      if (r.status === 404) return res.status(404).json({ error: 'Facility not found.' });
      if (!r.ok) throw new Error(`facility lookup ${r.status}`);
      f = await r.json();
    } catch (e) {
      return res.status(502).json({ error: 'Could not verify facility pricing. Try again.' });
    }
    if (!f.active) return res.status(409).json({ error: 'Facility is inactive.' });
    const totalCents = facilityTotalCents(f, { units, persons, startAt, endAt });
    if (!Number.isInteger(totalCents) || totalCents <= 0)
      return res.status(400).json({ error: 'Computed amount is invalid.' });

    const out = await prisma.$transaction(async (px) => {
      const folio = await px.folio.create({
        data: { folioNumber: nextFolioNumber(), type: 'WALKIN', currency: 'PHP' },
      });
      await px.folioTransaction.create({
        data: {
          folioId: folio.id,
          type: 'CHARGE',
          chargeCode: f.code,
          description: `${f.name}${f.unit ? ` (${f.unit})` : ''}${guestName ? ` — ${guestName}` : ''}`,
          amountCents: BigInt(totalCents),
          quantity: Number.isInteger(units) && units > 0 ? units : 1,
          postedBy: req.user?.username || req.user?.sub,
          sourceSystem: 'amenity-pos',
        },
      });
      const payment = await px.payment.create({
        data: { folioId: folio.id, method, amountCents: BigInt(totalCents), status: 'CAPTURED' },
      });
      await px.folioTransaction.create({
        data: {
          folioId: folio.id,
          type: 'PAYMENT',
          description: `Payment via ${method}`,
          amountCents: BigInt(totalCents),
          paymentMethod: method,
          reference: payment.id,
          postedBy: req.user?.username || req.user?.sub,
        },
      });
      const closed = await px.folio.update({
        where: { id: folio.id },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      return { folio: closed };
    });

    // Link the folio back to a hall/meeting-room booking, if this sale settled one.
    if (facilityBookingId) {
      // Fire-and-forget, so it needs the timeout even more than a awaited call: an
      // un-timed-out background fetch keeps the request's sockets and closures alive
      // long after the response has been sent.
      //
      // NOTE this remains a partial-commit hazard (finding H10) — the folio is
      // created whether or not this link lands, and a failure is only logged. That
      // is out of scope here; the timeout just stops it leaking.
      fetch(`${INVENTORY_URL}/api/facility-bookings/${facilityBookingId}`, {
        method: 'PATCH',
        signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceToken()}` },
        body: JSON.stringify({ folioId: out.folio.id }),
      }).catch((e) => console.warn('[Folio] booking link failed:', e.message));
    }
    redis.publish(
      'folio:closed',
      JSON.stringify({ folioId: out.folio.id, totalCents: String(totalCents), walkIn: true })
    );
    res.status(201).json({
      folioId: out.folio.id,
      folioNumber: out.folio.folioNumber,
      facility: f.name,
      amountCents: String(totalCents),
      method,
    });
  } catch (err) {
    console.error('[Folio] Amenity sale error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/folios/laundry-sale — per-piece laundry ticket (Changes-to-be-made
// doc, item 2). Several garment lines are priced authoritatively from inventory
// and posted as ONE charge, so the guest sees a single itemised laundry line
// rather than a transaction per sock.
//
// With a stayId the charge lands on that stay's open folio and settles at
// checkout; without one it opens a visitor (WALKIN) folio, takes payment and
// closes it — the same shape as amenity-sale.
router.post('/folios/laundry-sale', requireRole(...CASHIER), async (req, res) => {
  try {
    const { items, guestName, method, stayId } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items must be a non-empty array of { facilityCode, qty }.' });
    }
    if (!stayId && !method) {
      return res.status(400).json({ error: 'method is required for a visitor laundry sale.' });
    }

    // Authoritative pricing — never trust a client-supplied amount. One lookup
    // per garment code.
    const lines = [];
    for (const item of items) {
      if (!item?.facilityCode) return res.status(400).json({ error: 'Each item needs a facilityCode.' });
      let f;
      try {
        const r = await fetch(`${INVENTORY_URL}/api/facilities/${encodeURIComponent(item.facilityCode)}`, {
          signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${serviceToken()}` },
        });
        if (r.status === 404)
          return res.status(404).json({ error: `Laundry item ${item.facilityCode} not found.` });
        if (!r.ok) throw new Error(`facility lookup ${r.status}`);
        f = await r.json();
      } catch (e) {
        return res.status(502).json({ error: 'Could not verify laundry pricing. Try again.' });
      }
      if (!f.active) return res.status(409).json({ error: `${f.name} is not currently offered.` });
      // Garment SKUs are named "Laundry — Polo" so they group sensibly in the
      // amenity list, but the ticket line is already prefixed "Laundry:" —
      // keeping both would read "Laundry: 2× Laundry — Polo".
      const garment = f.name.replace(/^laundry\s*[—–-]\s*/i, '');
      lines.push({ name: garment, priceCents: f.priceCents, qty: item.qty });
    }

    let ticket;
    try {
      ticket = buildLaundryTicket(lines);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (!Number.isInteger(ticket.totalCents) || ticket.totalCents <= 0) {
      return res.status(400).json({ error: 'Computed amount is invalid.' });
    }

    const totalPieces = lines.reduce((n, l) => n + Number(l.qty || 0), 0);

    // ── In-house guest: post to the open folio, settle at checkout ──
    if (stayId) {
      const folio = await prisma.folio.findFirst({ where: { stayId, status: 'OPEN' } });
      if (!folio) return res.status(404).json({ error: 'No open folio for that stay.' });
      await prisma.folioTransaction.create({
        data: {
          folioId: folio.id,
          type: 'CHARGE',
          chargeCode: 'LD',
          description: ticket.description,
          amountCents: BigInt(ticket.totalCents),
          quantity: totalPieces,
          postedBy: req.user?.username || req.user?.sub,
          sourceSystem: 'laundry-pos',
        },
      });
      return res.status(201).json({
        folioId: folio.id,
        folioNumber: folio.folioNumber,
        totalCents: ticket.totalCents,
        description: ticket.description,
      });
    }

    // ── Visitor: open a WALKIN folio, charge, pay, close — atomically ──
    const out = await prisma.$transaction(async (px) => {
      const folio = await px.folio.create({
        data: { folioNumber: nextFolioNumber(), type: 'WALKIN', currency: 'PHP' },
      });
      await px.folioTransaction.create({
        data: {
          folioId: folio.id,
          type: 'CHARGE',
          chargeCode: 'LD',
          description: `${ticket.description}${guestName ? ` — ${guestName}` : ''}`,
          amountCents: BigInt(ticket.totalCents),
          quantity: totalPieces,
          postedBy: req.user?.username || req.user?.sub,
          sourceSystem: 'laundry-pos',
        },
      });
      const payment = await px.payment.create({
        data: { folioId: folio.id, method, amountCents: BigInt(ticket.totalCents), status: 'CAPTURED' },
      });
      await px.folioTransaction.create({
        data: {
          folioId: folio.id,
          type: 'PAYMENT',
          description: `Payment via ${method}`,
          amountCents: BigInt(ticket.totalCents),
          paymentMethod: method,
          reference: payment.id,
          postedBy: req.user?.username || req.user?.sub,
        },
      });
      return px.folio.update({
        where: { id: folio.id },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
    });

    redis.publish(
      'folio:closed',
      JSON.stringify({ folioId: out.id, totalCents: String(ticket.totalCents), walkIn: true })
    );
    res.status(201).json({
      folioId: out.id,
      folioNumber: out.folioNumber,
      totalCents: ticket.totalCents,
      description: ticket.description,
      method,
    });
  } catch (err) {
    console.error('[Folio] Laundry sale error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/folios?stayId=&guestId=&status=
router.get('/folios', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const { stayId, guestId, status } = req.query;
    const where = {};
    if (stayId) where.stayId = stayId;
    if (guestId) where.guestId = guestId;
    if (status) where.status = status;
    const folios = await prisma.folio.findMany({ where, orderBy: { openedAt: 'desc' }, take: 100 });
    res.json(folios);
  } catch (err) {
    console.error('[Folio] List folios error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/folios/outstanding?stayId=  — every open folio on a stay that still
// carries a balance. Purpose-built for the check-out guard in the stay service:
// with bill splitting a stay can have several folios, and releasing the room while
// one of them is unpaid strands the balance with nobody left to bill.
//
// Defined BEFORE /folios/:id so the literal path wins over the :id param route.
router.get('/folios/outstanding', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const { stayId } = req.query;
    if (!stayId) return res.status(400).json({ error: 'stayId is required.' });

    const folios = await prisma.folio.findMany({
      where: { stayId, status: 'OPEN' },
      include: { transactions: true },
    });

    // Same classifier the printed folio uses, so the number the desk is blocked on
    // is the number on the guest's bill — not a second, subtly different sum.
    const codeRows = await prisma.chargeCode.findMany({
      where: { category: { in: ['ROOM', 'FACILITY'] } },
      select: { code: true, category: true },
    });
    const codes = {
      roomCodes: new Set(codeRows.filter((c) => c.category === 'ROOM').map((c) => c.code)),
      facilityCodes: new Set(codeRows.filter((c) => c.category === 'FACILITY').map((c) => c.code)),
    };

    const unsettled = folios
      .map((f) => ({
        id: f.id,
        folioNumber: f.folioNumber,
        balanceCents: classifyTransactions(f.transactions, codes).balanceCents,
      }))
      .filter((f) => f.balanceCents !== 0n)
      .map((f) => ({ ...f, balanceCents: f.balanceCents.toString() }));

    res.json({ stayId, unsettled });
  } catch (err) {
    console.error('[Folio] Outstanding error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/folios/amenity-revenue?from=&to=  — walk-in amenity/facility sales,
// totalled and broken down by facility (charge code). Defined BEFORE /folios/:id
// so the literal path wins over the :id param route.
router.get('/folios/amenity-revenue', requireRole(...FINANCE), async (req, res) => {
  try {
    const { from, to } = req.query;
    // A date-only value (YYYY-MM-DD) means the hotel-LOCAL day — parse it at
    // local midnight (not UTC), so a range filter matches the property's day.
    const localDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s));
    const where = { type: 'CHARGE', sourceSystem: 'amenity-pos' };
    if (from || to) {
      where.postedAt = {};
      if (from) where.postedAt.gte = localDay(from);
      if (to) {
        const t = localDay(to);
        t.setDate(t.getDate() + 1);
        where.postedAt.lt = t;
      } // inclusive end-day
    }
    const txs = await prisma.folioTransaction.findMany({
      where,
      select: { chargeCode: true, amountCents: true },
    });
    const map = new Map();
    let total = 0n;
    for (const t of txs) {
      const k = t.chargeCode || '—';
      const e = map.get(k) || { code: k, count: 0, totalCents: 0n };
      e.count += 1;
      e.totalCents += t.amountCents;
      map.set(k, e);
      total += t.amountCents;
    }
    res.json({
      from,
      to,
      totalCents: total.toString(),
      count: txs.length,
      byFacility: [...map.values()]
        .map((e) => ({ code: e.code, count: e.count, totalCents: e.totalCents.toString() }))
        .sort((a, b) => Number(b.totalCents) - Number(a.totalCents)),
    });
  } catch (err) {
    console.error('[Folio] Amenity revenue error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/folios/daily-totals?date=YYYY-MM-DD
router.get('/folios/daily-totals', requireRole(...ROLE_GROUPS.MGMT_AUDIT), async (req, res) => {
  try {
    const d = req.query.date ? new Date(req.query.date) : new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const txs = await prisma.folioTransaction.findMany({
      where: { postedAt: { gte: start, lt: end } },
      select: { type: true, amountCents: true, taxAmountCents: true, chargeCode: true },
    });

    // Revenue is classified by the charge code's category, not a hardcoded 'ROOM'
    // string (the seeded room code is 'RM'). REFUND and ADJUSTMENT are included so
    // the night-audit revenue/payment figures actually reconcile.
    //
    // FACILITY is pulled out as its own bucket: walk-in facility sales are a
    // separate line of business from a resident guest's extras, and the night audit
    // is required to report them separately. Both categories are fetched in one
    // query rather than two round trips.
    const codeRows = await prisma.chargeCode.findMany({
      where: { category: { in: ['ROOM', 'FACILITY'] } },
      select: { code: true, category: true },
    });
    const roomCodes = new Set(codeRows.filter((c) => c.category === 'ROOM').map((c) => c.code));
    const facilityCodes = new Set(codeRows.filter((c) => c.category === 'FACILITY').map((c) => c.code));

    let roomRevenueCents = 0n;
    let facilityRevenueCents = 0n;
    let otherRevenueCents = 0n;
    let taxCents = 0n;
    let paymentsCents = 0n;
    for (const t of txs) {
      if (t.type === 'CHARGE') {
        if (roomCodes.has(t.chargeCode)) roomRevenueCents += t.amountCents;
        else if (facilityCodes.has(t.chargeCode)) facilityRevenueCents += t.amountCents;
        else otherRevenueCents += t.amountCents;
        taxCents += t.taxAmountCents;
      } else if (t.type === 'ADJUSTMENT') {
        otherRevenueCents += t.amountCents; // may be negative (a credit)
      } else if (t.type === 'PAYMENT') {
        paymentsCents += t.amountCents;
      } else if (t.type === 'REFUND') {
        paymentsCents -= t.amountCents; // a refund reduces net payments taken
      }
      // TRANSFER is deliberately absent, and unlike in classifyTransactions that is
      // correct here: a transfer posts a matched +/- pair in one database
      // transaction, so property-wide revenue for the day is unchanged. Counting it
      // would be harmless arithmetic but misleading to read.
    }

    res.json({
      date: start,
      roomRevenueCents: roomRevenueCents.toString(),
      facilityRevenueCents: facilityRevenueCents.toString(),
      otherRevenueCents: otherRevenueCents.toString(),
      taxCents: taxCents.toString(),
      paymentsCents: paymentsCents.toString(),
      transactionCount: txs.length,
    });
  } catch (err) {
    console.error('[Folio] Daily totals error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/folios/:id
router.get('/folios/:id', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const folio = await prisma.folio.findUnique({
      where: { id: req.params.id },
      include: { transactions: { orderBy: { postedAt: 'asc' } }, payments: true },
    });
    if (!folio) return res.status(404).json({ error: 'Not found.' });
    res.json(folio);
  } catch (err) {
    console.error('[Folio] Get folio error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/folios/:id/statement
router.get('/folios/:id/statement', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const folio = await prisma.folio.findUnique({
      where: { id: req.params.id },
      include: { transactions: { orderBy: { postedAt: 'asc' } }, payments: true },
    });
    if (!folio) return res.status(404).json({ error: 'Not found.' });

    // Delegated to classifyTransactions rather than summed inline. This route used
    // to carry its own copy of the balance formula, and when TRANSFER was added for
    // bill splitting the copy was not updated — so a folio whose charges had all
    // been moved off it still showed the full amount owing, while the folio that
    // received them showed nothing. One formula, one place.
    const codeRows = await prisma.chargeCode.findMany({
      where: { category: { in: ['ROOM', 'FACILITY'] } },
      select: { code: true, category: true },
    });
    const summary = classifyTransactions(folio.transactions, {
      roomCodes: new Set(codeRows.filter((c) => c.category === 'ROOM').map((c) => c.code)),
      facilityCodes: new Set(codeRows.filter((c) => c.category === 'FACILITY').map((c) => c.code)),
    });

    res.json({
      folio,
      balanceCents: summary.balanceCents.toString(),
      // TRANSFER counts as a charge line: on the receiving folio it is the only
      // thing there, and reporting "0 charges" beside a non-zero balance reads as
      // a bug to the person at the desk.
      totalCharges: folio.transactions.filter((t) => t.type === 'CHARGE' || t.type === 'TRANSFER').length,
      totalPayments: folio.payments.length,
    });
  } catch (err) {
    console.error('[Folio] Statement error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Loads a folio and rejects posting to a LOCKED/CLOSED one. Returns the folio,
// or sends the appropriate 404/409 and returns null.
async function requireOpenFolio(folioId, res) {
  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio) {
    res.status(404).json({ error: 'Folio not found.' });
    return null;
  }
  if (folio.status === 'LOCKED' || folio.status === 'CLOSED') {
    res.status(409).json({ error: `Folio is ${folio.status.toLowerCase()} and cannot accept postings.` });
    return null;
  }
  return folio;
}

// POST /api/folios/:id/charges
router.post('/folios/:id/charges', requireRole(...CASHIER), async (req, res) => {
  try {
    const {
      chargeCode,
      description,
      amountCents,
      taxAmountCents,
      postedBy,
      sourceSystem,
      reference,
      quantity,
      note,
    } = req.body;
    if ((await requireOpenFolio(req.params.id, res)) === null) return;
    const baseCents = parseCents(amountCents);
    const taxCents = taxAmountCents === undefined ? 0n : parseCents(taxAmountCents);
    if (baseCents === null || taxCents === null) {
      return res.status(400).json({ error: 'amountCents and taxAmountCents must be non-negative integers.' });
    }
    const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
    const totalCents = baseCents * BigInt(qty);
    const totalTaxCents = taxCents * BigInt(qty);
    let resolvedDesc = description;
    if (!resolvedDesc && chargeCode) {
      const cc = await prisma.chargeCode.findUnique({ where: { code: chargeCode } });
      resolvedDesc = cc?.name || chargeCode;
    }
    const tx = await prisma.folioTransaction.create({
      data: {
        folioId: req.params.id,
        type: 'CHARGE',
        chargeCode,
        description: resolvedDesc || 'Charge',
        amountCents: totalCents,
        taxAmountCents: totalTaxCents,
        quantity: qty,
        note,
        postedBy: postedBy || req.user?.username || req.user?.sub,
        sourceSystem,
        reference,
      },
    });
    redis.publish(
      'folio:charge_posted',
      JSON.stringify({
        folioId: req.params.id,
        txId: tx.id,
        chargeCode,
        amountCents: tx.amountCents.toString(),
      })
    );
    res.status(201).json(tx);
  } catch (err) {
    console.error('[Folio] Post charge error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/folios/:id/payments
router.post('/folios/:id/payments', requireRole(...CASHIER), async (req, res) => {
  try {
    const { method, amountCents, gatewayRef, cardMasked, reference } = req.body;
    if ((await requireOpenFolio(req.params.id, res)) === null) return;
    const payCents = parseCents(amountCents);
    if (!method || payCents === null || payCents === 0n) {
      return res.status(400).json({ error: 'method and a positive integer amountCents are required.' });
    }
    // Payment row and its ledger transaction must be written together, or a
    // crash between them leaves the folio balance and the payment record out
    // of sync.
    const payment = await prisma.$transaction(async (px) => {
      const p = await px.payment.create({
        data: {
          folioId: req.params.id,
          method,
          amountCents: payCents,
          gatewayRef: gatewayRef || reference,
          cardMasked,
          status: 'AUTHORIZED',
        },
      });
      await px.folioTransaction.create({
        data: {
          folioId: req.params.id,
          type: 'PAYMENT',
          description: `Payment via ${method}`,
          amountCents: payCents,
          paymentMethod: method,
          postedBy: req.user?.username || req.user?.sub,
          reference: p.id,
        },
      });
      return p;
    });
    redis.publish(
      'folio:payment_received',
      JSON.stringify({
        folioId: req.params.id,
        paymentId: payment.id,
        amountCents: payment.amountCents.toString(),
      })
    );
    redis.publish(
      'payment:authorized',
      JSON.stringify({
        folioId: req.params.id,
        paymentId: payment.id,
      })
    );
    res.status(201).json(payment);
  } catch (err) {
    console.error('[Folio] Payment error:', err.message);
    redis.publish('payment:failed', JSON.stringify({ folioId: req.params.id, error: err.message }));
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/folios/:id/refund — refund a previous payment
router.post('/folios/:id/refund', requireRole(...FINANCE), async (req, res) => {
  try {
    const { originalTxId, amountCents, reason } = req.body;
    const refundCents = parseCents(amountCents);
    if (!originalTxId || refundCents === null) {
      return res.status(400).json({ error: 'originalTxId and a valid integer amountCents are required.' });
    }
    const original = await prisma.folioTransaction.findUnique({ where: { id: originalTxId } });
    if (!original) return res.status(404).json({ error: 'Original transaction not found.' });
    if (original.type !== 'PAYMENT') return res.status(400).json({ error: 'Original must be a payment.' });
    // Cap cumulative refunds at the original payment amount, not just this one.
    const priorRefunds = await prisma.folioTransaction.aggregate({
      where: { type: 'REFUND', refundOfId: originalTxId },
      _sum: { amountCents: true },
    });
    const alreadyRefunded = priorRefunds._sum.amountCents || 0n;
    if (alreadyRefunded + refundCents > original.amountCents) {
      return res.status(400).json({
        error: 'Cumulative refunds cannot exceed the original payment amount.',
        alreadyRefundedCents: alreadyRefunded.toString(),
        originalAmountCents: original.amountCents.toString(),
      });
    }
    // Wrap in a transaction so the refund row + payment status flip are atomic.
    const tx = await prisma.$transaction(async (px) => {
      const refundTx = await px.folioTransaction.create({
        data: {
          folioId: req.params.id,
          type: 'REFUND',
          description: `Refund (${reason || 'no reason'})`,
          amountCents: refundCents,
          paymentMethod: original.paymentMethod,
          refundOfId: originalTxId,
          refundReason: reason,
          postedBy: req.user?.username || req.user?.sub,
        },
      });
      // Mark the original Payment row REFUNDED if a matching one exists. This
      // keeps reports consistent — un-reconciled refunds were a real bug.
      if (original.reference) {
        await px.payment.updateMany({
          where: { id: original.reference, status: { in: ['AUTHORIZED', 'CAPTURED'] } },
          data: { status: 'REFUNDED' },
        });
      }
      return refundTx;
    });
    redis.publish(
      'folio:refund_posted',
      JSON.stringify({
        folioId: req.params.id,
        txId: tx.id,
        originalTxId,
        amountCents: tx.amountCents.toString(),
      })
    );
    res.status(201).json(tx);
  } catch (err) {
    console.error('[Folio] Refund error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/folios/:id/adjustments
router.post('/folios/:id/adjustments', requireRole(...FINANCE), async (req, res) => {
  try {
    const { description, amountCents, postedBy } = req.body;
    if ((await requireOpenFolio(req.params.id, res)) === null) return;
    // Adjustments may be positive (debit) or negative (credit), but must be an integer.
    if (typeof amountCents !== 'number' || !Number.isInteger(amountCents)) {
      return res.status(400).json({ error: 'amountCents must be an integer number of cents.' });
    }
    const tx = await prisma.folioTransaction.create({
      data: {
        folioId: req.params.id,
        type: 'ADJUSTMENT',
        description,
        amountCents: BigInt(amountCents),
        postedBy: postedBy || req.user?.username || req.user?.sub,
      },
    });
    res.status(201).json(tx);
  } catch (err) {
    console.error('[Folio] Adjustment error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/folios/:id/void-transaction/:txId
router.post('/folios/:id/void-transaction/:txId', requireRole(...FINANCE), async (req, res) => {
  try {
    const original = await prisma.folioTransaction.findUnique({ where: { id: req.params.txId } });
    if (!original) return res.status(404).json({ error: 'Transaction not found.' });
    // The transaction must belong to the folio in the path (no cross-folio voids).
    if (original.folioId !== req.params.id) {
      return res.status(400).json({ error: 'Transaction does not belong to this folio.' });
    }
    // A reversal row is itself un-voidable, and a transaction can only be voided once.
    if (original.reversalOf) {
      return res.status(400).json({ error: 'Cannot void a reversal transaction.' });
    }
    const existingReversal = await prisma.folioTransaction.findFirst({ where: { reversalOf: original.id } });
    if (existingReversal) {
      return res.status(409).json({ error: 'Transaction has already been voided.' });
    }

    const reversal = await prisma.folioTransaction.create({
      data: {
        folioId: req.params.id,
        type: original.type,
        chargeCode: original.chargeCode,
        description: `REVERSAL of ${original.description}`,
        amountCents: -original.amountCents,
        taxAmountCents: -original.taxAmountCents,
        reversalOf: original.id,
      },
    });
    // If the voided transaction was a payment linked to a Payment row, flip it to VOIDED.
    if (original.type === 'PAYMENT' && original.reference) {
      await prisma.payment
        .updateMany({
          where: { id: original.reference, status: { in: ['AUTHORIZED', 'CAPTURED'] } },
          data: { status: 'VOIDED' },
        })
        .catch(() => {});
    }
    res.json(reversal);
  } catch (err) {
    console.error('[Folio] Void tx error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/folios/:id/transfer — move one transaction to another folio on the
// same stay. This is the mechanism behind bill splitting: the front desk opens a
// second folio for the stay (POST /api/folios with the same stayId) and moves the
// lines that a different payer is settling.
//
// Guarded tightly on purpose. Both folios must be OPEN, both must belong to the
// SAME stay, and a transfer may not itself be transferred — otherwise a charge
// could be walked off a stay entirely, or bounced between folios until its history
// is unreadable.
router.post('/folios/:id/transfer', requireRole(...CASHIER), async (req, res) => {
  try {
    const { transactionId, toFolioId } = req.body;
    if (!transactionId || !toFolioId) {
      return res.status(400).json({ error: 'transactionId and toFolioId are required.' });
    }

    const [from, to] = await Promise.all([
      prisma.folio.findUnique({ where: { id: req.params.id } }),
      prisma.folio.findUnique({ where: { id: toFolioId } }),
    ]);
    if (!from || !to) return res.status(404).json({ error: 'Folio not found.' });
    if (from.id === to.id) return res.status(400).json({ error: 'Cannot transfer to the same folio.' });
    if (from.status !== 'OPEN' || to.status !== 'OPEN') {
      return res.status(409).json({ error: 'Both folios must be open to transfer a charge.' });
    }
    // A folio with no stay is a walk-in POS sale. Allowing a transfer off one would
    // let a cashier move a stranger's bar tab onto a guest's room account.
    if (!from.stayId || from.stayId !== to.stayId) {
      return res.status(409).json({ error: 'Folios must belong to the same stay.' });
    }

    const tx = await prisma.folioTransaction.findUnique({ where: { id: transactionId } });
    if (!tx || tx.folioId !== from.id) {
      return res.status(404).json({ error: 'Transaction not found on this folio.' });
    }
    if (tx.type === 'TRANSFER') {
      return res.status(409).json({ error: 'A transfer cannot itself be transferred.' });
    }
    if (tx.type === 'PAYMENT' || tx.type === 'REFUND') {
      return res.status(409).json({ error: 'Only charges and adjustments can be transferred, not payments.' });
    }

    const rows = planTransfer(tx, {
      fromFolioId: from.id,
      toFolioId: to.id,
      folioNumbers: { [from.id]: from.folioNumber, [to.id]: to.folioNumber },
    });

    // One transaction: a half-applied transfer would invent or destroy money.
    const created = await prisma.$transaction(
      rows.map((data) =>
        prisma.folioTransaction.create({
          data: { ...data, postedBy: req.user?.username || req.user?.sub, sourceSystem: 'transfer' },
        })
      )
    );

    redis.publish(
      'folio:transferred',
      JSON.stringify({ fromFolioId: from.id, toFolioId: to.id, transactionId, stayId: from.stayId })
    );
    res.status(201).json({ transactions: created });
  } catch (err) {
    console.error('[Folio] Transfer error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/folios/:id/lock
// POST /api/folios/:id/settle — checkout settlement: pay the outstanding balance
// (if any) with the given method, then close the folio. Front-desk cashiering.
router.post('/folios/:id/settle', requireRole(...CASHIER), async (req, res) => {
  try {
    const { method } = req.body;
    const folio = await prisma.folio.findUnique({
      where: { id: req.params.id },
      include: { transactions: true },
    });
    if (!folio) return res.status(404).json({ error: 'Folio not found.' });
    if (folio.status === 'CLOSED') return res.status(409).json({ error: 'Folio is already closed.' });

    // Balance owed: charges/tax/adjustments add, payments subtract, refunds add back.
    let balance = 0n;
    for (const t of folio.transactions) {
      if (t.type === 'CHARGE' || t.type === 'TAX' || t.type === 'ADJUSTMENT')
        balance += t.amountCents + t.taxAmountCents;
      else if (t.type === 'PAYMENT') balance -= t.amountCents;
      else if (t.type === 'REFUND') balance += t.amountCents;
    }
    if (balance > 0n && !method) {
      return res.status(400).json({
        error: 'method is required to settle an outstanding balance.',
        balanceCents: balance.toString(),
      });
    }

    const out = await prisma.$transaction(async (px) => {
      let settledCents = 0n;
      if (balance > 0n) {
        const payment = await px.payment.create({
          data: { folioId: folio.id, method, amountCents: balance, status: 'CAPTURED' },
        });
        await px.folioTransaction.create({
          data: {
            folioId: folio.id,
            type: 'PAYMENT',
            description: `Settlement via ${method}`,
            amountCents: balance,
            paymentMethod: method,
            reference: payment.id,
            postedBy: req.user?.username || req.user?.sub,
          },
        });
        settledCents = balance;
      }
      const closed = await px.folio.update({
        where: { id: folio.id },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      return { closed, settledCents };
    });

    // Gross charged (for loyalty accrual), same convention as /close.
    let totalCents = 0n;
    for (const t of folio.transactions) {
      if (t.type === 'CHARGE' || t.type === 'TAX' || t.type === 'ADJUSTMENT')
        totalCents += t.amountCents + t.taxAmountCents;
    }
    if (totalCents < 0n) totalCents = 0n;
    redis.publish(
      'folio:settled',
      JSON.stringify({ folioId: folio.id, settledCents: out.settledCents.toString() })
    );
    redis.publish(
      'folio:closed',
      JSON.stringify({
        folioId: folio.id,
        stayId: folio.stayId,
        guestId: folio.guestId,
        totalCents: totalCents.toString(),
      })
    );
    res.json({
      folioId: folio.id,
      status: 'CLOSED',
      settledCents: out.settledCents.toString(),
      method: out.settledCents > 0n ? method : null,
    });
  } catch (err) {
    console.error('[Folio] Settle error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/folios/:id/lock', requireRole(...FINANCE), async (req, res) => {
  try {
    const folio = await prisma.folio.update({
      where: { id: req.params.id },
      data: { status: 'LOCKED' },
    });
    res.json(folio);
  } catch (err) {
    console.error('[Folio] Lock error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/folios/:id/close
router.post('/folios/:id/close', requireRole(...FINANCE), async (req, res) => {
  try {
    const folio = await prisma.folio.update({
      where: { id: req.params.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    // Total charged (gross of charges/tax/adjustments) drives loyalty accrual in
    // the guest service, which reads totalCents off this event.
    const txs = await prisma.folioTransaction.findMany({
      where: { folioId: folio.id },
      select: { type: true, amountCents: true, taxAmountCents: true },
    });
    let totalCents = 0n;
    for (const t of txs) {
      if (t.type === 'CHARGE' || t.type === 'TAX' || t.type === 'ADJUSTMENT')
        totalCents += t.amountCents + t.taxAmountCents;
    }
    if (totalCents < 0n) totalCents = 0n;
    redis.publish('folio:settled', JSON.stringify({ folioId: folio.id }));
    redis.publish(
      'folio:closed',
      JSON.stringify({
        folioId: folio.id,
        stayId: folio.stayId,
        guestId: folio.guestId,
        totalCents: totalCents.toString(),
      })
    );
    res.json(folio);
  } catch (err) {
    console.error('[Folio] Close error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/charge-codes
router.get('/charge-codes', requireRole(...ROLE_GROUPS.ALL_STAFF), async (req, res) => {
  try {
    const codes = await prisma.chargeCode.findMany({ orderBy: { code: 'asc' } });
    res.json(codes);
  } catch (err) {
    console.error('[Folio] List charge codes error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/charge-codes
router.post('/charge-codes', requireRole(...ADMIN), async (req, res) => {
  try {
    const { code, name, category, glAccount, taxable } = req.body;
    if (!code || !name || !category) {
      return res.status(400).json({ error: 'code, name, category required.' });
    }
    const cc = await prisma.chargeCode.create({
      data: { code, name, category, glAccount, taxable: taxable !== false },
    });
    res.status(201).json(cc);
  } catch (err) {
    console.error('[Folio] Create charge code error:', err.message);
    if (err.code === 'P2002') return res.status(409).json({ error: 'Charge code already exists.' });
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/folios/:id/deposit  (advance deposit — pre-arrival payment)
router.post('/folios/:id/deposit', requireRole(...CASHIER), async (req, res) => {
  try {
    const { method, amountCents, reference } = req.body;
    const depositCents = parseCents(amountCents);
    if (!method || depositCents === null) {
      return res.status(400).json({ error: 'method and a valid integer amountCents are required.' });
    }
    const payment = await prisma.payment.create({
      data: {
        folioId: req.params.id,
        method,
        amountCents: depositCents,
        status: 'AUTHORIZED',
        gatewayRef: reference,
      },
    });
    await prisma.folioTransaction.create({
      data: {
        folioId: req.params.id,
        type: 'PAYMENT',
        description: `Advance deposit via ${method}`,
        amountCents: depositCents,
        reference: payment.id,
      },
    });
    redis.publish(
      'folio:deposit_received',
      JSON.stringify({
        folioId: req.params.id,
        paymentId: payment.id,
        amountCents: payment.amountCents.toString(),
      })
    );
    res.status(201).json(payment);
  } catch (err) {
    console.error('[Folio] Deposit error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/folios/:id/early-departure-adjustment
router.post('/folios/:id/early-departure-adjustment', requireRole(...FINANCE), async (req, res) => {
  try {
    const { unusedNights, nightlyRateCents, reason } = req.body;
    if ((await requireOpenFolio(req.params.id, res)) === null) return;
    const nights = Number(unusedNights || 0);
    const rate = parseCents(nightlyRateCents);
    if (!Number.isInteger(nights) || nights <= 0 || rate === null || rate <= 0n) {
      return res.status(400).json({ error: 'unusedNights and nightlyRateCents must be positive integers.' });
    }
    const refundCents = -(rate * BigInt(nights));
    const tx = await prisma.folioTransaction.create({
      data: {
        folioId: req.params.id,
        type: 'ADJUSTMENT',
        description: `Early departure refund — ${nights} unused night(s)${reason ? `: ${reason}` : ''}`,
        amountCents: refundCents,
        postedBy: req.user?.sub,
      },
    });
    redis.publish(
      'folio:early_departure_adjusted',
      JSON.stringify({
        folioId: req.params.id,
        txId: tx.id,
        refundCents: refundCents.toString(),
        unusedNights: nights,
      })
    );
    res.status(201).json(tx);
  } catch (err) {
    console.error('[Folio] Early departure adjustment error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/folios/:id/print — renders a guest folio/receipt as PDF, formatted
// to match the panel's reference invoice (Changes-to-be-made doc, item 2).
router.get('/folios/:id/print', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const folio = await prisma.folio.findUnique({
      where: { id: req.params.id },
      include: { transactions: { orderBy: { postedAt: 'asc' } } },
    });
    if (!folio) return res.status(404).json({ error: 'Not found.' });

    const roomCodes = new Set(
      (await prisma.chargeCode.findMany({ where: { category: 'ROOM' }, select: { code: true } })).map(
        (c) => c.code
      )
    );
    const summary = classifyTransactions(folio.transactions, roomCodes);

    const guest = folio.guestId
      ? await fetchJsonOrNull(`${GUEST_URL}/api/guests/${encodeURIComponent(folio.guestId)}`)
      : null;
    const stay = folio.stayId
      ? await fetchJsonOrNull(`${STAY_URL}/api/stays/${encodeURIComponent(folio.stayId)}`)
      : null;
    const reservation = stay?.reservationId
      ? await fetchJsonOrNull(`${RESERVATION_URL}/api/reservations/${encodeURIComponent(stay.reservationId)}`)
      : null;

    const nights = reservation?.nights || 1;
    const tariffCents = summary.roomChargeCents / BigInt(nights);
    const guestName = stay?.guestName || reservation?.guestName || '—';
    const money = (cents) => `${folio.currency} ${(Number(cents) / 100).toFixed(2)}`;
    const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');
    const fmtTime = (d) => (d ? new Date(d).toISOString().slice(11, 16) : '—');
    const fmtDateTime = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—');

    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="folio-${folio.folioNumber}.pdf"`);
    doc.pipe(res);

    // ── Header ──
    doc.fontSize(18).text('InnSight PMS', { align: 'center' });
    doc.fontSize(11).fillColor('#555').text('Guest Folio', { align: 'center' });
    doc.moveDown(0.8).fillColor('black');

    // ── Guest / stay grid ──
    // No "G.R. Card No." row: InnSight has no physical registration-card
    // concept, so the confirmation number stands in for it. No guest address
    // line: not a field this system captures.
    const row = (label, value) => {
      doc.font('Helvetica-Bold').fontSize(9).text(label, { continued: true, width: 150 });
      doc.font('Helvetica').text(`  ${value ?? '—'}`);
    };
    row('Folio No.:', folio.folioNumber);
    row('Date:', fmtDate(new Date()));
    row('Guest Name:', guestName);
    row('Nationality:', guest?.nationality || '—');
    row('No. of Pax:', reservation ? reservation.adults + reservation.children : '—');
    row('Adult / Child:', reservation ? `${reservation.adults} / ${reservation.children}` : '—');
    row('Confirmation No.:', reservation?.confirmationNumber || '—');
    row('Date of Arrival:', fmtDate(stay?.actualCheckInAt || reservation?.checkIn));
    row('Date of Departure:', fmtDate(stay?.actualCheckOutAt || reservation?.checkOut));
    row('Time of Arrival:', fmtTime(stay?.actualCheckInAt));
    row('Tariff:', money(tariffCents));
    doc.moveDown();

    // ── Particulars ──
    // No Tax1-4 slots: InnSight tracks one combined taxAmountCents per charge
    // rather than a decomposed VAT/service-charge/local-tax breakdown — an honest
    // deviation from the literal reference template, documented in the design spec.
    //
    // Transfers ARE supported now (POST /folios/:id/transfer, added for bill
    // splitting). They need no section of their own: a transfer posts a matched
    // pair of TRANSFER rows that name the other folio in their description, so
    // they read in line with the rest of the particulars.
    doc.fontSize(11).text('Particulars', { underline: true });
    doc.moveDown(0.3);
    const line = (label, value, opts = {}) => {
      doc.fontSize(9).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica');
      doc.text(label, 60, doc.y, { continued: true, width: 380 });
      doc.text(value, { align: 'right' });
    };
    line('Room Charges', money(summary.roomChargeCents));
    line('Add: Taxes', money(summary.taxCents));
    line('Add: Extra Charges', money(summary.extraChargeCents));
    doc.moveDown(0.3);
    line('Total Charges', money(summary.totalChargesCents), { bold: true });
    doc.moveDown(0.3);
    line('Less: Payments', money(summary.paymentsCents));
    if (summary.refundsCents > 0n) line('Less: Refunds', `-${money(summary.refundsCents)}`);
    line('Adjustments', money(summary.adjustmentsCents));
    doc.moveDown(0.3);
    doc.moveTo(48, doc.y).lineTo(547, doc.y).stroke();
    doc.moveDown(0.3);
    line('Balance', money(summary.balanceCents), { bold: true });
    doc.moveDown();

    doc.fontSize(9).font('Helvetica-Bold').text(`This Folio is in: ${folio.currency}`);
    doc.font('Helvetica').text(`Amount in Words: ${centsToWords(summary.balanceCents)}`);
    doc.moveDown();

    doc
      .fontSize(8)
      .fillColor('#555')
      .text(
        'NOTICE TO GUESTS: This property is privately owned and the management reserves the right to ' +
          'refuse service to anyone. Management will not be responsible for accidents or injury to guests ' +
          'or for loss of money, jewelry or valuables of any kind. Management will not be responsible for ' +
          'any item left in the room.',
        { align: 'justify' }
      );
    doc.moveDown(0.5);
    doc.fillColor('#888').text(`Printed ${fmtDateTime(new Date())} — InnSight PMS`, { align: 'center' });

    doc.end();
  } catch (err) {
    console.error('[Folio] Print error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
