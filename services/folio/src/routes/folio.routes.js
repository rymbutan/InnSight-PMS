const express = require('express');
const PDFDocument = require('pdfkit');
const Redis = require('ioredis');
const { requireRole, ROLE_GROUPS, signServiceToken } = require('../middleware/auth');
const { classifyTransactions } = require('../lib/folioSummary');
const { auditApprovalOf } = require('../lib/auditApproval');
const { folioListRow } = require('../lib/folioList');
const { folioPrintModel } = require('../lib/folioPrintModel');
const { buildLaundryTicket } = require('../lib/laundryTicket');
const { planTransfer } = require('../lib/transfer');
const { allocate, netRemaining, planSplit } = require('../lib/split');
const { receiptModel } = require('../lib/receipt');
const { send: sendMail } = require('../lib/notifier');
const { qrPngBuffer, qrDataUrl } = require('../lib/qr');
const { newToken, intentState, INTENT_TTL_MS, LINK_TTL_MS } = require('../lib/paymentIntent');
const { publicUrl } = require('../lib/publicUrl');
const { validateTaxRates, validateHotel, validatePaymentFeePercent } = require('../lib/settings');
const {
  getTaxRates,
  getHotel,
  saveTaxRates,
  saveHotel,
  getPaymentFeePercent,
  savePaymentFeePercent,
} = require('../lib/settingsStore');
const { computeTax, paymentProcessingFeeCents } = require('../lib/policies');
const { postRefund, findPaymentTx, refundableCents } = require('../lib/refund');
const { PAYMENT_METHODS, isEWallet, simulateGatewayRef } = require('../lib/paymentMethods');
const storage = require('../lib/storage');

const ADMIN = ['ADMIN', 'MANAGER'];
const FINANCE = ['ADMIN', 'MANAGER', 'AUDITOR'];
// Front-desk cashiering: open folios and post charges/payments/deposits.
// (ADMIN is included so the night-audit service token can post room charges.)
const CASHIER = ['ADMIN', 'MANAGER', 'FRONT_DESK'];
// Same ceiling as the reservation service's own document uploads
// (services/reservation/src/routes/reservation.routes.js) — a deposit slip
// photo or PDF, not a large file.
const MAX_PROOF_BYTES = 10 * 1024 * 1024;

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

const crypto = require('crypto');

const router = express.Router();
// A second, unauthenticated router for the folio's QR code — mounted by
// index.js BEFORE verifyToken, exactly like the PaymentIntent public routes.
// Kept here rather than duplicated in index.js because serving it means
// rebuilding the same print model this file already builds for staff.
const publicRouter = express.Router();
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

// ── Folio configuration ─────────────────────────────────────────────────────
// Reachable only through the longer-prefix gateway locations for
// /api/settings/tax-rates and /api/settings/hotel; the bare /api/settings prefix
// still proxies to the reservation service.

// GET /api/settings/tax-rates?country=XX — every desk role, because the folio
// screen shows the rates a charge will attract.
//
// `country` is optional. Omitted, this returns the rates that actually apply
// to a real charge today — the PROPERTY's own jurisdiction (`hotel_country`),
// never a guest's nationality; see policies.js for why. Passed explicitly, it
// returns that country's rates instead, so Settings can browse or edit a
// jurisdiction other than the one currently active without touching it. The
// response always carries which country it answered for, in `country`.
router.get('/settings/tax-rates', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    res.json(await getTaxRates(req.query.country));
  } catch (err) {
    console.error('[Folio] Get tax rates error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/settings/tax-rates?country=XX — management only. These change what
// guests are billed WHEN that country is the property's active jurisdiction;
// saving a non-active country's rates in advance is harmless (nothing reads
// them until the property is switched to it).
router.put('/settings/tax-rates', requireRole(...ROLE_GROUPS.MGMT), async (req, res) => {
  try {
    const country = req.query.country || (await getHotel()).country;
    const result = validateTaxRates(country, req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(await saveTaxRates(country, result.rates));
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

// GET /api/settings/payment-fee-percent — the CARD/BANK_TRANSFER surcharge
// percentage (see POST /folios/:id/payments and policies.js's
// paymentProcessingFeeCents). 0 until an operator sets one.
router.get('/settings/payment-fee-percent', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    res.json({ feePercent: await getPaymentFeePercent() });
  } catch (err) {
    console.error('[Folio] Get payment fee percent error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/settings/payment-fee-percent — management only. Changes what a
// guest paying by card or bank transfer is charged from this point on;
// already-posted fees are untouched.
router.put('/settings/payment-fee-percent', requireRole(...ROLE_GROUPS.MGMT), async (req, res) => {
  try {
    const result = validatePaymentFeePercent(req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ feePercent: await savePaymentFeePercent(result.feePercent) });
  } catch (err) {
    console.error('[Folio] Set payment fee percent error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

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
      const matches = await fetchJsonOrNull(`${GUEST_URL}/api/guests/search?q=${encodeURIComponent(term)}`);
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

    // Whether a stay's bill was split: a stay with MORE THAN ONE folio on it.
    // Counted across ALL folios on that stay, not just the ones matching this
    // page's search/filter — a split-off folio must still read as "Split"
    // even if the current search term happens to match only the other one.
    // One groupBy for the whole page, not a query per row.
    const stayIds = [...new Set(folios.map((f) => f.stayId).filter(Boolean))];
    const splitStayIds = new Set();
    if (stayIds.length) {
      const counts = await prisma.folio.groupBy({
        by: ['stayId'],
        where: { stayId: { in: stayIds } },
        _count: { _all: true },
      });
      for (const c of counts) {
        if (c._count._all > 1) splitStayIds.add(c.stayId);
      }
    }

    res.json(
      folios.map((f) =>
        folioListRow(f, codes, names.get(f.guestId), {
          isSplit: f.stayId ? splitStayIds.has(f.stayId) : false,
        })
      )
    );
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

    // Folios still awaiting night-audit sign-off, reported alongside the unpaid
    // ones so the check-out guard makes both decisions from a single call. A
    // zero balance is not the same as a CHECKED balance: the second question is
    // whether an auditor has confirmed the charges and payments are right.
    const unapproved = folios
      .map((f) => ({ f, a: auditApprovalOf(f, f.transactions) }))
      .filter(({ a }) => !a.approved)
      .map(({ f, a }) => ({
        id: f.id,
        folioNumber: f.folioNumber,
        // Distinguishes "never checked" from "checked, then the bill moved".
        stale: a.stale,
      }));

    res.json({ stayId, unsettled, unapproved });
  } catch (err) {
    console.error('[Folio] Outstanding error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Night-audit sign-off ────────────────────────────────────────────────────
// POST /api/folios/:id/audit-approve — the auditor confirms this folio's charges
// and payments are correct, which is what releases it for check-out.
//
// AUDITOR and ADMIN only — deliberately NOT Manager or Front Desk. The whole
// value of the control is that the person who takes the money is not the person
// who certifies it: letting the desk approve its own folio would make the gate
// a formality. Admin is kept as the break-glass path for a property with no
// auditor on shift, and every approval records WHO gave it.
const AUDIT_SIGNOFF = ['AUDITOR', 'ADMIN'];
router.post('/folios/:id/audit-approve', requireRole(...AUDIT_SIGNOFF), async (req, res) => {
  try {
    const folio = await prisma.folio.findUnique({
      where: { id: req.params.id },
      include: { transactions: true },
    });
    if (!folio) return res.status(404).json({ error: 'Folio not found.' });
    if (folio.status !== 'OPEN') {
      return res.status(409).json({ error: `Only an open folio can be approved (current: ${folio.status}).` });
    }
    const updated = await prisma.folio.update({
      where: { id: folio.id },
      data: { auditApprovedAt: new Date(), auditApprovedBy: req.user?.sub || null },
    });
    // Approving is what unblocks a guest waiting at the desk, so it is worth a
    // live event rather than leaving the desk to re-poll the folio.
    redis.publish(
      'folio:audit',
      JSON.stringify({
        event: 'folio.audit_approved',
        folioId: folio.id,
        folioNumber: folio.folioNumber,
        stayId: folio.stayId,
      })
    );
    res.json({
      id: updated.id,
      folioNumber: updated.folioNumber,
      auditApprovedAt: updated.auditApprovedAt,
      auditApprovedBy: updated.auditApprovedBy,
    });
  } catch (err) {
    console.error('[Folio] Audit approve error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/folios/:id/audit-revoke — withdraw a sign-off given in error.
// Same roles: whoever may certify a bill must be able to un-certify it, or a
// mistaken approval can only be undone in the database.
router.post('/folios/:id/audit-revoke', requireRole(...AUDIT_SIGNOFF), async (req, res) => {
  try {
    const folio = await prisma.folio.findUnique({ where: { id: req.params.id } });
    if (!folio) return res.status(404).json({ error: 'Folio not found.' });
    const updated = await prisma.folio.update({
      where: { id: folio.id },
      data: { auditApprovedAt: null, auditApprovedBy: null },
    });
    // Same reasoning as approve's own publish: another screen watching this
    // folio (or the checkout guard) needs to know its approval just vanished,
    // not just the tab that clicked Revoke.
    redis.publish(
      'folio:audit',
      JSON.stringify({
        event: 'folio.audit_revoked',
        folioId: folio.id,
        folioNumber: folio.folioNumber,
        stayId: folio.stayId,
      })
    );
    res.json({ id: updated.id, folioNumber: updated.folioNumber, auditApprovedAt: null });
  } catch (err) {
    console.error('[Folio] Audit revoke error:', err.message);
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
      include: {
        transactions: { orderBy: { postedAt: 'asc' }, include: { dispute: true } },
        payments: { include: { proof: true } },
      },
    });
    if (!folio) return res.status(404).json({ error: 'Not found.' });

    // The split-bill dialog defaults its payer count to this booking's guest
    // count, so it fetched here rather than making the browser call the
    // reservation service separately just to draw a default.
    const stay = folio.stayId
      ? await fetchJsonOrNull(`${STAY_URL}/api/stays/${encodeURIComponent(folio.stayId)}`)
      : null;
    const reservation = stay?.reservationId
      ? await fetchJsonOrNull(`${RESERVATION_URL}/api/reservations/${encodeURIComponent(stay.reservationId)}`)
      : null;

    // `guestName` here is the reservation's, NOT a Guest-service profile join
    // (Folio.guestId is null on almost every folio — that field links an
    // actual Guest record, which is optional and usually absent — so a
    // lookup keyed on it came up empty for nearly every folio that has a
    // real, named guest attached via its stay). The reservation's guestName
    // is a required, always-present string, so this is reliable wherever a
    // folio has a stayId at all.
    // The DERIVED approval, not just the raw column: the page has to be able to
    // show "approved, then the bill changed" as its own state, and that is a
    // comparison against the transactions rather than anything stored.
    const audit = auditApprovalOf(folio, folio.transactions);
    res.json({
      ...folio,
      // A walk-in has no reservation, so its party size lives on the stay
      // itself instead (see stay.routes.js's POST /api/walk-in) — falling
      // back to it here is what keeps a walk-in folio's guest count from
      // reading as unknown next to every reservation-backed one.
      adults: reservation?.adults ?? stay?.adults ?? null,
      children: reservation?.children ?? stay?.children ?? null,
      // Same walk-in gap as adults/children above: a walk-in's guest name
      // lives only on the Stay (there is no reservation to source it from),
      // so leaving this reservation-only meant every walk-in folio showed
      // "no guest on file" even when the desk had typed a name at check-in.
      guestName: reservation?.guestName ?? stay?.guestName ?? null,
      auditApproved: audit.approved,
      auditApprovalStale: audit.stale,
    });
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
      include: {
        transactions: { orderBy: { postedAt: 'asc' }, include: { dispute: true } },
        payments: { include: { proof: true } },
      },
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

// A method's own required fields, checked BEFORE anything is written — never
// trust the client-side modal alone to have enforced them (see
// NewReservation.jsx-style comments elsewhere in this codebase about
// authoritative server-side checks). Returns an error string, or null when
// the payload is complete enough to post.
//
// Card: brand+last4 (cardMasked) and the cardholder's name are required —
// what a receipt already shows. The transaction/authorization code is NOT
// required here: a real terminal doesn't always hand the cashier one to
// copy, so it falls back to a simulated "AUTH-…" code (simulateGatewayRef)
// exactly like before.
//
// Bank transfer: bank, network, sender name AND the bank's own reference/
// control number are all required — unlike Card, there is nothing to
// simulate a bank reference FROM; a bank transfer this system cannot verify
// against a real control number teaches the wrong lesson about what
// "confirming" one means.
function missingPaymentField(method, body) {
  if (method === 'CARD') {
    if (!body.cardMasked) return 'Card brand and last 4 digits are required.';
    if (!body.cardholderName || !String(body.cardholderName).trim()) {
      return 'Cardholder name is required for a card payment.';
    }
  }
  if (method === 'BANK_TRANSFER') {
    if (!body.bankName || !String(body.bankName).trim()) return 'Bank name is required.';
    if (!body.transferNetwork || !String(body.transferNetwork).trim()) {
      return 'Transfer network/channel is required.';
    }
    if (!body.senderName || !String(body.senderName).trim()) {
      return "Sender/account holder's name is required.";
    }
    if (!(body.gatewayRef || body.reference)) {
      return 'A bank reference/control number is required for a bank transfer.';
    }
  }
  return null;
}

// POST /api/folios/:id/payments
router.post('/folios/:id/payments', requireRole(...CASHIER), async (req, res) => {
  try {
    const {
      method,
      amountCents,
      gatewayRef,
      cardMasked,
      reference,
      cardholderName,
      bankName,
      transferNetwork,
      senderName,
      transferredAt,
    } = req.body;
    if ((await requireOpenFolio(req.params.id, res)) === null) return;
    const payCents = parseCents(amountCents);
    if (!method || payCents === null || payCents === 0n) {
      return res.status(400).json({ error: 'method and a positive integer amountCents are required.' });
    }
    const missing = missingPaymentField(method, req.body);
    if (missing) return res.status(400).json({ error: missing });

    let transferredAtDate = null;
    if (transferredAt !== undefined && transferredAt !== null && transferredAt !== '') {
      transferredAtDate = new Date(transferredAt);
      if (Number.isNaN(transferredAtDate.getTime())) {
        return res.status(400).json({ error: 'transferredAt is not a valid date.' });
      }
    }

    // A surcharge for the two methods that actually cost the property
    // something to process — never cash, never a manual e-wallet entry (the
    // guest's own wallet already took whatever cut it takes; this system has
    // no visibility into that and must not invent a second fee on top of it).
    const feePercent = method === 'CARD' || method === 'BANK_TRANSFER' ? await getPaymentFeePercent() : 0;
    const feeCents = paymentProcessingFeeCents({ amountCents: payCents, feePercent });

    // Payment row and its ledger transaction must be written together, or a
    // crash between them leaves the folio balance and the payment record out
    // of sync.
    // A staff-entered gatewayRef/reference always wins; only a genuinely
    // blank one falls back to a simulated one (an "AUTH-" code for CARD —
    // BANK_TRANSFER's reference is validated as mandatory above, so its
    // fallback in simulateGatewayRef is dead code here on purpose, kept only
    // as defense-in-depth for a caller that bypasses this validation).
    const resolvedGatewayRef = gatewayRef || reference || simulateGatewayRef(method);
    const payment = await prisma.$transaction(async (px) => {
      const p = await px.payment.create({
        data: {
          folioId: req.params.id,
          method,
          amountCents: payCents,
          gatewayRef: resolvedGatewayRef,
          cardMasked,
          cardholderName: method === 'CARD' ? cardholderName : undefined,
          bankName: method === 'BANK_TRANSFER' ? bankName : undefined,
          transferNetwork: method === 'BANK_TRANSFER' ? transferNetwork : undefined,
          senderName: method === 'BANK_TRANSFER' ? senderName : undefined,
          transferredAt: method === 'BANK_TRANSFER' ? transferredAtDate : undefined,
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
          // Payment.id, NOT gatewayRef — postRefund() looks up the Payment
          // row by THIS field (`payment.updateMany({ where: { id:
          // original.reference } })`) to flip it REFUNDED. Every
          // payment-posting route in this file keeps this the same;
          // gatewayRef is a separate, human-facing field, never the lookup
          // key.
          reference: p.id,
        },
      });
      // The fee is a CHARGE, not a deduction from the payment: the guest paid
      // the full amountCents, and now owes a bit more because of HOW they
      // paid it — the same "surcharge raises the balance" shape a real folio
      // uses, and it shows up in the Ledger and the folio's overall balance
      // on its own, with no change needed to classifyTransactions.
      if (feeCents > 0n) {
        await px.folioTransaction.create({
          data: {
            folioId: req.params.id,
            type: 'CHARGE',
            chargeCode: 'PF',
            description: `Payment processing fee (${feePercent}% of ${method === 'CARD' ? 'card' : 'bank transfer'} payment)`,
            amountCents: feeCents,
            postedBy: req.user?.username || req.user?.sub,
            sourceSystem: 'payment-fee',
            reference: `PROCESSINGFEE-${p.id}`,
          },
        });
      }
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
    // feeCents rides along on the response (not a Payment/FolioTransaction
    // field itself) so the desk screen can show what was actually added,
    // right after posting, without a second round trip.
    res.status(201).json({ ...payment, feeCents: feeCents.toString(), feePercent });
  } catch (err) {
    console.error('[Folio] Payment error:', err.message);
    redis.publish('payment:failed', JSON.stringify({ folioId: req.params.id, error: err.message }));
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/folios/:id/payments/:paymentId/proof — attach the deposit
// slip/bank confirmation image or PDF a BANK_TRANSFER payment was posted
// with. filename/contentType/contentBase64, same shape as the reservation
// service's own document upload (services/reservation/src/routes/
// reservation.routes.js) — bytes go to MinIO (lib/storage.js), only metadata
// is stored here. A payment carries at most one proof, so a second upload
// REPLACES the first rather than erroring — front desk fixing a wrong scan
// shouldn't need a delete-then-upload round trip.
router.post('/folios/:id/payments/:paymentId/proof', requireRole(...CASHIER), async (req, res) => {
  try {
    const payment = await prisma.payment.findFirst({
      where: { id: req.params.paymentId, folioId: req.params.id },
    });
    if (!payment) return res.status(404).json({ error: 'Payment not found on this folio.' });

    const { filename, contentType, contentBase64 } = req.body || {};
    if (!filename || !String(filename).trim())
      return res.status(400).json({ error: 'filename is required.' });
    if (!contentBase64) return res.status(400).json({ error: 'contentBase64 is required.' });

    let buffer;
    try {
      buffer = Buffer.from(contentBase64, 'base64');
    } catch {
      return res.status(400).json({ error: 'contentBase64 is not valid base64.' });
    }
    if (buffer.length === 0) return res.status(400).json({ error: 'The uploaded file is empty.' });
    if (buffer.length > MAX_PROOF_BYTES) {
      return res.status(400).json({
        error: `File is ${(buffer.length / (1024 * 1024)).toFixed(1)}MB, over the ${MAX_PROOF_BYTES / (1024 * 1024)}MB limit.`,
      });
    }

    const existing = await prisma.paymentDocument.findUnique({ where: { paymentId: payment.id } });
    const objectKey = storage.objectKeyFor(payment.id, filename);
    await storage.ensureBucket();
    await storage.putDocument(objectKey, buffer, contentType);
    // The old object is removed AFTER the new one is safely written, so a
    // failed upload never leaves a payment with no proof at all.
    if (existing) await storage.removeDocument(existing.objectKey).catch(() => {});

    const doc = await prisma.paymentDocument.upsert({
      where: { paymentId: payment.id },
      create: {
        paymentId: payment.id,
        filename: String(filename),
        contentType: contentType || 'application/octet-stream',
        sizeBytes: buffer.length,
        objectKey,
        uploadedBy: req.user?.username || req.user?.sub,
      },
      update: {
        filename: String(filename),
        contentType: contentType || 'application/octet-stream',
        sizeBytes: buffer.length,
        objectKey,
        uploadedBy: req.user?.username || req.user?.sub,
      },
    });
    res.status(201).json(doc);
  } catch (err) {
    console.error('[Folio] Upload payment proof error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/folios/:id/payments/:paymentId/proof — streams the file back
// through this service rather than a direct MinIO link, so it stays behind
// the same gateway auth as everything else; MinIO itself is never reachable
// from a browser.
router.get(
  '/folios/:id/payments/:paymentId/proof',
  requireRole(...ROLE_GROUPS.DESK_AUDIT),
  async (req, res) => {
    try {
      const payment = await prisma.payment.findFirst({
        where: { id: req.params.paymentId, folioId: req.params.id },
      });
      if (!payment) return res.status(404).json({ error: 'Payment not found on this folio.' });

      const doc = await prisma.paymentDocument.findUnique({ where: { paymentId: payment.id } });
      if (!doc) return res.status(404).json({ error: 'No proof of transfer on file for this payment.' });

      const stream = await storage.getDocumentStream(doc.objectKey);
      res.setHeader('Content-Type', doc.contentType);
      res.setHeader('Content-Disposition', `inline; filename="${doc.filename.replace(/"/g, '')}"`);
      stream.on('error', (err) => {
        console.error('[Folio] Proof stream error:', err.message);
        if (!res.headersSent) res.status(502).json({ error: 'Could not read the stored file.' });
      });
      stream.pipe(res);
    } catch (err) {
      console.error('[Folio] Download payment proof error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
    }
  }
);

// POST /api/folios/:id/refund — refund a previous payment
router.post('/folios/:id/refund', requireRole(...FINANCE), async (req, res) => {
  try {
    const { originalTxId, amountCents, reason } = req.body;
    const refundCents = parseCents(amountCents);
    if (!originalTxId || refundCents === null) {
      return res.status(400).json({ error: 'originalTxId and a valid integer amountCents are required.' });
    }
    // Wrapped in a transaction so the refund row + payment status flip are
    // atomic — postRefund itself does not open one, so a caller already
    // inside a transaction (PaymentDispute approval, below) can share it.
    const result = await prisma.$transaction((px) =>
      postRefund(px, {
        folioId: req.params.id,
        originalTxId,
        amountCents: refundCents,
        reason,
        postedBy: req.user?.username || req.user?.sub,
      })
    );
    if (!result.ok) {
      const { ok: _ok, status, error, ...extra } = result;
      return res.status(status).json({ error, ...extra });
    }
    redis.publish(
      'folio:refund_posted',
      JSON.stringify({
        folioId: req.params.id,
        txId: result.tx.id,
        originalTxId,
        amountCents: result.tx.amountCents.toString(),
      })
    );
    res.status(201).json(result.tx);
  } catch (err) {
    console.error('[Folio] Refund error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/payment-methods — the single list every payment-method dropdown
// and every classification decision (e.g. "is this an e-wallet") reads,
// rather than each screen hardcoding its own copy. See lib/paymentMethods.js.
router.get('/payment-methods', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (_req, res) => {
  res.json(Object.entries(PAYMENT_METHODS).map(([code, m]) => ({ code, ...m })));
});

// ── E-wallet refund/chargeback disputes ─────────────────────────────────────
// A claim against a GCash or Maya payment. Distinct from the plain /refund
// route above because a wallet claim can arrive from the gateway itself (a
// chargeback), and unlike a desk-initiated refund its outcome is not always
// known the moment it is filed — see the PaymentDisputeStatus comment in
// schema.prisma for the state machine this enforces.
const DISPUTE_TYPES = ['REFUND_REQUEST', 'CHARGEBACK'];
// Which decisions are reachable from which status. PENDING is the only entry
// point (there is no route that creates a case in any other status), and
// APPROVED/REJECTED are terminal — neither appears as a FROM key.
const DISPUTE_TRANSITIONS = {
  PENDING: ['APPROVED', 'REJECTED', 'DISPUTED'],
  DISPUTED: ['APPROVED', 'REJECTED'],
};
// Every decision the resolve route understands at all, as opposed to the ones
// reachable from a given status. A decision outside this list is a malformed
// request, not a rejected transition — the transition message would otherwise
// answer `decision: "banana"` with "a PENDING dispute can only move to…",
// which reads as if banana were a state it could have moved to.
const DISPUTE_DECISIONS = [...new Set(Object.values(DISPUTE_TRANSITIONS).flat())];
// A case that has not reached a terminal status: it is still claiming money
// that has not moved. Doubles as the filter for "is a case already open
// against this payment" below.
const OPEN_DISPUTE_STATUSES = Object.keys(DISPUTE_TRANSITIONS);
const DISPUTE_STATUSES = [...OPEN_DISPUTE_STATUSES, 'APPROVED', 'REJECTED'];
// Payment statuses a claim can be filed against. A VOIDED or FAILED payment
// never settled, and a REFUNDED one has already gone back in full — neither
// has anything left for a gateway to claw back.
const DISPUTABLE_PAYMENT_STATUSES = ['AUTHORIZED', 'CAPTURED'];

// Aborts an interactive $transaction with a chosen HTTP response. It has to be
// a throw: RETURNING a value from the callback COMMITS, so a failed refund
// inside dispute approval would otherwise leave the case marked APPROVED with
// no refund behind it.
class DisputeAbort extends Error {
  constructor(payload) {
    super(payload.error || 'Dispute aborted.');
    this.payload = payload;
  }
}
function sendDisputeAbort(res, payload) {
  const { ok: _ok, status, error, ...extra } = payload;
  return res.status(status || 400).json({ error, ...extra });
}
// Someone else moved the case between this request's read and its write. The
// caller did nothing wrong; their view is just stale.
const STALE_DISPUTE = {
  status: 409,
  error: 'This dispute was already acted on by someone else. Reload it and check its current status.',
};

// POST /api/folios/:id/payments/:paymentId/disputes — file a new case.
router.post('/folios/:id/payments/:paymentId/disputes', requireRole(...FINANCE), async (req, res) => {
  try {
    const { type, reason } = req.body;
    if (!DISPUTE_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${DISPUTE_TYPES.join(', ')}.` });
    }
    const payment = await prisma.payment.findUnique({ where: { id: req.params.paymentId } });
    if (!payment || payment.folioId !== req.params.id) {
      return res.status(404).json({ error: 'Payment not found on this folio.' });
    }
    if (!isEWallet(payment.method)) {
      return res.status(400).json({
        error: `${payment.method} is not an e-wallet payment. Use /folios/:id/refund for cash, card, or bank transfer.`,
      });
    }
    if (!DISPUTABLE_PAYMENT_STATUSES.includes(payment.status)) {
      return res
        .status(409)
        .json({ error: `This payment is ${payment.status} — there is nothing left to dispute.` });
    }
    // One open case per payment. Without this the same wallet payment could
    // carry three PENDING full-value claims at once: the first approval pays
    // out and the other two then die at postRefund's cumulative cap, having sat
    // in the queue looking payable the whole time.
    const open = await prisma.paymentDispute.findFirst({
      where: { paymentId: payment.id, status: { in: OPEN_DISPUTE_STATUSES } },
    });
    if (open) {
      return res.status(409).json({
        error: `A ${open.status} case is already open against this payment. Resolve that one before filing another.`,
        disputeId: open.id,
      });
    }
    // Approval refunds against the payment's ledger row, so a case whose row
    // cannot be found can never pay out. Say so now, rather than after the case
    // has been filed, queued and approved.
    const originalTx = await findPaymentTx(prisma, { folioId: req.params.id, paymentId: payment.id });
    if (!originalTx) {
      return res.status(409).json({ error: 'Could not find the ledger transaction for this payment.' });
    }
    // The ceiling is what is STILL refundable, not the original amount. A
    // payment already partly refunded at the desk has that much less left to
    // claim; checking against the original let a case be filed — and queued as
    // payable — for money that had already gone back.
    const { alreadyRefunded, remaining } = await refundableCents(prisma, originalTx);
    if (remaining <= 0n) {
      return res.status(409).json({
        error: 'This payment has already been refunded in full.',
        alreadyRefundedCents: alreadyRefunded.toString(),
      });
    }
    const amountCents =
      req.body.amountCents === undefined ? remaining : parseCents(req.body.amountCents);
    if (amountCents === null || amountCents <= 0n || amountCents > remaining) {
      return res.status(400).json({
        error: 'amountCents must be a positive integer no greater than the amount still refundable.',
        remainingRefundableCents: remaining.toString(),
      });
    }
    const dispute = await prisma.paymentDispute.create({
      data: {
        folioId: req.params.id,
        paymentId: payment.id,
        method: payment.method,
        type,
        amountCents,
        reason,
        filedBy: req.user?.username || req.user?.sub,
      },
    });
    redis.publish(
      'folio:dispute_filed',
      JSON.stringify({ folioId: req.params.id, disputeId: dispute.id, type, method: payment.method })
    );
    res.status(201).json(dispute);
  } catch (err) {
    console.error('[Folio] File dispute error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/payment-disputes?status=&folioId=&paymentId= — every desk role can
// see the queue; only FINANCE can file or resolve one (below).
router.get('/payment-disputes', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const { status, folioId, paymentId } = req.query;
    // `status` goes straight into a Prisma enum filter, so an unknown value is
    // a client typo that used to surface as a 500 from the query layer.
    if (status && !DISPUTE_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${DISPUTE_STATUSES.join(', ')}.` });
    }
    const where = {};
    if (status) where.status = status;
    if (folioId) where.folioId = folioId;
    if (paymentId) where.paymentId = paymentId;
    const disputes = await prisma.paymentDispute.findMany({ where, orderBy: { filedAt: 'desc' } });
    res.json(disputes);
  } catch (err) {
    console.error('[Folio] List disputes error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/payment-disputes/:disputeId/resolve — move a case to APPROVED,
// REJECTED, or DISPUTED. APPROVED posts the actual refund, reusing the exact
// same lib/refund.js logic the plain /refund route calls, so a wallet claim
// cannot invent a second way to move money against the amount already
// refunded.
router.post('/payment-disputes/:disputeId/resolve', requireRole(...FINANCE), async (req, res) => {
  try {
    const { decision, resolutionNote } = req.body;
    if (!DISPUTE_DECISIONS.includes(decision)) {
      return res.status(400).json({ error: `decision must be one of: ${DISPUTE_DECISIONS.join(', ')}.` });
    }
    const note =
      typeof resolutionNote === 'string' && resolutionNote.trim() ? resolutionNote.trim() : undefined;

    const dispute = await prisma.paymentDispute.findUnique({ where: { id: req.params.disputeId } });
    if (!dispute) return res.status(404).json({ error: 'Dispute not found.' });

    const allowed = DISPUTE_TRANSITIONS[dispute.status] || [];
    if (!allowed.includes(decision)) {
      // 409, not 400: the request is well formed, it just arrived at a case
      // that has moved past the point where this decision means anything.
      return res.status(409).json({
        error: allowed.length
          ? `A ${dispute.status} dispute can only move to: ${allowed.join(', ')}.`
          : `A ${dispute.status} dispute is already resolved and cannot be changed.`,
      });
    }

    const resolvedBy = req.user?.username || req.user?.sub;

    if (decision === 'APPROVED') {
      // Find the payment's own PAYMENT-type transaction to refund against —
      // postRefund refunds against a FolioTransaction, and Payment/
      // FolioTransaction are linked by FolioTransaction.reference === Payment.id
      // (see the /payments route above, and /refund's originalTxId).
      const originalTx = await findPaymentTx(prisma, {
        folioId: dispute.folioId,
        paymentId: dispute.paymentId,
      });
      if (!originalTx) {
        return res.status(409).json({ error: 'Could not find the ledger transaction for this payment.' });
      }
      let result;
      try {
        result = await prisma.$transaction(async (px) => {
          // Claim the case BEFORE posting the refund, filtered on the status
          // the transition check above was made against. That filter is what
          // makes two simultaneous Approve clicks safe: the second matches no
          // rows and aborts, instead of both reading PENDING and both paying
          // the same claim out. postRefund's cumulative cap only catches that
          // when the two refunds together exceed the payment — two approvals of
          // a 40% claim went straight through it.
          const claimed = await px.paymentDispute.updateMany({
            where: { id: dispute.id, status: dispute.status },
            data: { status: 'APPROVED', resolvedBy, resolvedAt: new Date(), resolutionNote: note },
          });
          if (claimed.count === 0) throw new DisputeAbort(STALE_DISPUTE);

          const refund = await postRefund(px, {
            folioId: dispute.folioId,
            originalTxId: originalTx.id,
            amountCents: dispute.amountCents,
            reason: `${dispute.type === 'CHARGEBACK' ? 'Chargeback' : 'E-wallet refund'} — ${dispute.reason || 'no reason'}`,
            postedBy: resolvedBy,
          });
          // Throw rather than return: returning commits, which would mark the
          // case APPROVED with no refund behind it.
          if (!refund.ok) throw new DisputeAbort(refund);

          const updated = await px.paymentDispute.update({
            where: { id: dispute.id },
            data: { refundTxId: refund.tx.id },
          });
          return { dispute: updated, refundTx: refund.tx };
        });
      } catch (err) {
        if (err instanceof DisputeAbort) return sendDisputeAbort(res, err.payload);
        throw err;
      }
      redis.publish(
        'folio:dispute_resolved',
        JSON.stringify({
          folioId: dispute.folioId,
          disputeId: dispute.id,
          status: 'APPROVED',
          resolvedBy,
          refundTxId: result.refundTx.id,
        })
      );
      // An approval moves real money, so everything watching for refunds — not
      // just the dispute queue — has to hear about it. The plain /refund route
      // publishes this; a refund that arrived through a dispute used to move
      // the money silently, leaving the statement and the folio list stale
      // until someone reloaded by hand.
      redis.publish(
        'folio:refund_posted',
        JSON.stringify({
          folioId: dispute.folioId,
          txId: result.refundTx.id,
          originalTxId: originalTx.id,
          amountCents: result.refundTx.amountCents.toString(),
        })
      );
      return res.json(result.dispute);
    }

    // REJECTED or DISPUTED — a status change only, no money moves. Same
    // status-filtered write as the approval path, so a decision cannot land on
    // a case somebody else has already moved.
    const data =
      decision === 'DISPUTED'
        ? // Escalated to the gateway: still open, so nothing is resolved and
          // resolvedBy/resolvedAt stay empty for whoever closes it out. The
          // note is kept — it is the only record of WHY the case went to the
          // gateway, and it used to be dropped on the floor here.
          { status: 'DISPUTED', resolutionNote: note }
        : { status: 'REJECTED', resolvedBy, resolvedAt: new Date(), resolutionNote: note };
    const changed = await prisma.paymentDispute.updateMany({
      where: { id: dispute.id, status: dispute.status },
      data,
    });
    if (changed.count === 0) return sendDisputeAbort(res, STALE_DISPUTE);
    const updated = await prisma.paymentDispute.findUnique({ where: { id: dispute.id } });
    redis.publish(
      'folio:dispute_resolved',
      JSON.stringify({
        folioId: dispute.folioId,
        disputeId: dispute.id,
        status: decision,
        // Who escalated a case matters as much as who closed it, and DISPUTED
        // deliberately leaves resolvedBy empty on the row.
        actedBy: resolvedBy,
      })
    );
    res.json(updated);
  } catch (err) {
    console.error('[Folio] Resolve dispute error:', err.message);
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

// POST /api/folios/:id/void-transaction/:txId — disputing/cancelling a
// charge (Reservations & Walk-Ins item 1: "Maria Santa, Lane A-02"). FINANCE
// already matches the requested audience (AUDITOR + MANAGER, plus ADMIN as
// the same break-glass path every other money-moving/sign-off action in this
// file uses). A reason is now mandatory and an optional screenshot — e.g. of
// the guest conversation the auditor is citing — travels with it; both are
// filed on a FolioTransactionDispute row keyed to the ORIGINAL transaction,
// alongside the reversal this route already knew how to post.
router.post('/folios/:id/void-transaction/:txId', requireRole(...FINANCE), async (req, res) => {
  try {
    const { reason, screenshotFilename, screenshotContentType, screenshotContentBase64 } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'A reason is required to dispute or cancel a charge.' });
    }
    let screenshotBuffer = null;
    if (screenshotContentBase64) {
      if (!screenshotFilename || !String(screenshotFilename).trim()) {
        return res.status(400).json({ error: 'screenshotFilename is required with screenshotContentBase64.' });
      }
      try {
        screenshotBuffer = Buffer.from(screenshotContentBase64, 'base64');
      } catch {
        return res.status(400).json({ error: 'screenshotContentBase64 is not valid base64.' });
      }
      if (screenshotBuffer.length === 0) return res.status(400).json({ error: 'The uploaded screenshot is empty.' });
      if (screenshotBuffer.length > MAX_PROOF_BYTES) {
        return res.status(400).json({
          error: `File is ${(screenshotBuffer.length / (1024 * 1024)).toFixed(1)}MB, over the ${MAX_PROOF_BYTES / (1024 * 1024)}MB limit.`,
        });
      }
    }

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
    // `reversalOf` carries two meanings: "voids that row" (here) and "is half of
    // a transfer pair for that row" (lib/transfer.js, lib/split.js). Both block a
    // void, and should — a charge whose money now sits on another folio must not
    // be voided out from under the folios carrying it. But they are not the same
    // event, and reporting a transferred charge as "already voided" sends the
    // desk looking for a void that never happened. A split posts up to seven
    // pairs per line, so this was about to become the common case.
    const existingReversal = await prisma.folioTransaction.findFirst({
      where: { reversalOf: original.id },
      orderBy: { postedAt: 'asc' },
    });
    if (existingReversal) {
      return res.status(409).json({
        error:
          existingReversal.type === 'TRANSFER'
            ? 'This charge has been split or transferred to another folio. Void it there, or move the share back first.'
            : 'Transaction has already been voided.',
      });
    }

    // The reversal carries the NEGATED breakdown of the row it reverses, not a
    // null. taxAmountCents remains the single source of truth for the totals —
    // this only decides which component lines the reversed tax is shown
    // against. Left null, the print model's pre-migration fallback attributed
    // the whole negative figure to VAT, so a voided taxed charge printed a
    // fabricated "VAT -1,000.00 / Service Charge +1,000.00" pair that nets to
    // zero (which is why no subtotal check ever caught it).
    const originalBreakdown = Array.isArray(original.taxBreakdown) ? original.taxBreakdown : null;
    const reversalBreakdown = originalBreakdown?.length
      ? originalBreakdown.map((b) => ({
          ...b,
          // Stored as decimal STRINGS: BigInt has no JSON representation.
          amountCents: (-BigInt(b.amountCents || 0)).toString(),
        }))
      : null;

    const actor = req.user?.username || req.user?.sub || null;
    const reversal = await prisma.folioTransaction.create({
      data: {
        folioId: req.params.id,
        type: original.type,
        chargeCode: original.chargeCode,
        description: `REVERSAL of ${original.description}`,
        amountCents: -original.amountCents,
        taxAmountCents: -original.taxAmountCents,
        taxBreakdown: reversalBreakdown,
        reversalOf: original.id,
        // Previously left null on every void — an anonymous reversal in a
        // ledger otherwise stamped with who posted every other line.
        postedBy: actor,
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

    // Uploaded AFTER the reversal is safely posted, same sequencing the
    // payment-proof route uses — a failed screenshot write must not undo an
    // otherwise-successful dispute/void.
    let screenshotMeta = {};
    if (screenshotBuffer) {
      const objectKey = storage.objectKeyForDispute(original.id, screenshotFilename);
      await storage.ensureBucket();
      await storage.putDocument(objectKey, screenshotBuffer, screenshotContentType);
      screenshotMeta = {
        screenshotFilename: String(screenshotFilename),
        screenshotContentType: screenshotContentType || 'application/octet-stream',
        screenshotSizeBytes: screenshotBuffer.length,
        screenshotObjectKey: objectKey,
      };
    }
    const dispute = await prisma.folioTransactionDispute.upsert({
      where: { transactionId: original.id },
      create: {
        transactionId: original.id,
        reversalTransactionId: reversal.id,
        reason: String(reason).trim(),
        filedBy: actor,
        ...screenshotMeta,
      },
      // A transaction can only be voided once (guarded above), so update()
      // is unreachable in practice — upsert is used only so a redelivered
      // request can't crash on the dispute row after already posting the
      // reversal once.
      update: {
        reversalTransactionId: reversal.id,
        reason: String(reason).trim(),
        filedBy: actor,
        ...screenshotMeta,
      },
    });

    // Another screen showing this same ledger needs to see the void without
    // a manual refresh, same as any other folio-changing action.
    redis.publish(
      'folio:transaction_voided',
      JSON.stringify({
        event: 'folio.transaction_voided',
        folioId: req.params.id,
        transactionId: original.id,
        reversalTransactionId: reversal.id,
      })
    );

    res.json({ ...reversal, dispute });
  } catch (err) {
    console.error('[Folio] Void tx error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/folios/:id/transactions/:txId/dispute/screenshot — streams the
// evidence image back through this service, same discipline as the payment
// proof download (never a direct MinIO link).
router.get(
  '/folios/:id/transactions/:txId/dispute/screenshot',
  requireRole(...ROLE_GROUPS.DESK_AUDIT),
  async (req, res) => {
    try {
      const original = await prisma.folioTransaction.findFirst({
        where: { id: req.params.txId, folioId: req.params.id },
      });
      if (!original) return res.status(404).json({ error: 'Transaction not found.' });
      const dispute = await prisma.folioTransactionDispute.findUnique({
        where: { transactionId: original.id },
      });
      if (!dispute?.screenshotObjectKey) {
        return res.status(404).json({ error: 'No screenshot on file for this dispute.' });
      }
      const stream = await storage.getDocumentStream(dispute.screenshotObjectKey);
      res.setHeader('Content-Type', dispute.screenshotContentType || 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${(dispute.screenshotFilename || 'screenshot').replace(/"/g, '')}"`
      );
      stream.on('error', (err) => {
        console.error('[Folio] Dispute screenshot stream error:', err.message);
        if (!res.headersSent) res.status(502).json({ error: 'Could not read the stored file.' });
      });
      stream.pipe(res);
    } catch (err) {
      console.error('[Folio] Download dispute screenshot error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
    }
  }
);

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
      return res
        .status(409)
        .json({ error: 'Only charges and adjustments can be transferred, not payments.' });
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

// POST /api/folios/:id/split — divide this folio's charges across several payers.
//
// The real bill-splitting action. `transfer` above moves ONE WHOLE transaction;
// this divides every charge on the folio by a share vector, which is what the
// desk means by "split it 60/40" or "split it three ways". Before this existed
// the only "Split bill" control opened an empty second folio and left the
// operator to move each charge by hand — and any charge that did not divide into
// whole cents could not be divided at all.
//
// Emits the same reversing TRANSFER pairs as `transfer`, for the same reason
// (lib/transfer.js explains it), so balances, the printed folio's sections and
// the night audit all keep working with no changes: classifyTransactions already
// counts TRANSFER exactly like CHARGE.
//
// `dryRun` returns what a split WOULD do and writes nothing. The dialog's live
// preview uses it, so the figures the operator confirms are produced by this
// same code rather than by a second implementation of money-rounding in the web
// bundle that nothing would check for drift.
router.post('/folios/:id/split', requireRole(...CASHIER), async (req, res) => {
  try {
    const { method, payers, dryRun } = req.body || {};

    if (method !== 'EQUAL' && method !== 'PERCENT') {
      return res.status(400).json({ error: "method must be 'EQUAL' or 'PERCENT'." });
    }
    if (!Array.isArray(payers) || payers.length < 2 || payers.length > 8) {
      return res.status(400).json({ error: 'A split needs between 2 and 8 payers.' });
    }

    // Every folio a split produces must be able to say who it bills — that is
    // the whole point of naming payers, so an unnamed one is rejected rather
    // than quietly defaulted to the guest.
    const names = payers.map((p) => String(p?.payerName || '').trim());
    if (names.some((n) => !n)) {
      return res.status(400).json({ error: 'Every payer needs a name.' });
    }
    if (names.some((n) => n.length > 120)) {
      return res.status(400).json({ error: 'A payer name may be at most 120 characters.' });
    }

    let shares;
    if (method === 'EQUAL') {
      // Derived here, not taken from the client: nothing sensible can be sent
      // for "100 divided by 3" and a client that tries will send 33.33 thrice,
      // which does not sum to 100.
      shares = payers.map(() => 1);
    } else {
      shares = payers.map((p) => Number(p?.percent));
      if (shares.some((n) => !Number.isFinite(n) || n <= 0)) {
        return res.status(400).json({ error: 'Every share must be a percentage greater than zero.' });
      }
      // Compared as integers scaled by 100 so 33.33 + 33.33 + 33.34 is accepted
      // without reaching for a float epsilon.
      const scaled = shares.reduce((a, n) => a + Math.round(n * 100), 0);
      if (scaled !== 10000) {
        return res.status(400).json({ error: 'Shares must add up to exactly 100%.' });
      }
    }

    const source = await prisma.folio.findUnique({
      where: { id: req.params.id },
      include: { transactions: { orderBy: { postedAt: 'asc' } } },
    });
    if (!source) return res.status(404).json({ error: 'Folio not found.' });
    if (source.status !== 'OPEN') {
      return res.status(409).json({ error: 'Only an open folio can be split.' });
    }
    // A folio with no stay is a walk-in POS sale. The transfer guard refuses to
    // move charges off one, and a split must not become a way around that.
    if (!source.stayId) {
      return res.status(409).json({ error: 'Only a folio attached to a stay can be split.' });
    }

    // Is there anything left to divide? A folio whose charges have all been
    // split away already would otherwise report a cheerful success having
    // written nothing.
    const splittable = source.transactions.filter(
      (t) => t.type !== 'PAYMENT' && t.type !== 'REFUND' && t.type !== 'TRANSFER'
    );
    const divisible = splittable.some((t) => {
      const net = netRemaining(t, source.transactions);
      return net.amountCents !== 0n || net.taxAmountCents !== 0n;
    });
    if (!divisible) {
      return res.status(409).json({ error: 'This folio has no charges left to split.' });
    }

    // What each payer's folio ends up holding. Computed from the same allocate()
    // the rows are built with, so a preview cannot disagree with the split.
    const previewFor = (folioNumbers) => {
      const totals = shares.map(() => 0n);
      for (const tx of splittable) {
        const net = netRemaining(tx, source.transactions);
        const amounts = allocate(net.amountCents, shares);
        const taxes = allocate(net.taxAmountCents, shares);
        for (let i = 0; i < shares.length; i++) totals[i] += amounts[i] + taxes[i];
      }
      const scaledTotal = shares.reduce((a, n) => a + n, 0);
      return payers.map((p, i) => ({
        payerName: names[i],
        percent: method === 'EQUAL' ? 100 / shares.length : Number(p.percent),
        share: shares[i] / scaledTotal,
        folioNumber: folioNumbers ? folioNumbers[i] : null,
        isSource: i === 0,
        totalCents: totals[i].toString(),
      }));
    };

    if (dryRun) {
      return res.json({
        dryRun: true,
        method,
        payers: previewFor([source.folioNumber]),
      });
    }

    // Distinct by construction. nextFolioNumber() is Date.now() plus 3 random
    // digits, and these are created inside one transaction well within a single
    // millisecond — a ~1-in-1000 collision per pair against a @unique column,
    // which would abort the whole split.
    const newNumbers = payers.slice(1).map((_, i) => `${nextFolioNumber()}-${i + 1}`);

    const out = await prisma.$transaction(async (px) => {
      // The source folio is payers[0] and keeps its own share. It needs its
      // payerName set too: without it the folio holding the largest share is the
      // one document that still cannot say who it bills.
      const updatedSource = await px.folio.update({
        where: { id: source.id },
        data: { payerName: names[0] },
      });

      const created = [];
      for (let i = 1; i < payers.length; i++) {
        created.push(
          await px.folio.create({
            data: {
              folioNumber: newNumbers[i - 1],
              stayId: source.stayId,
              guestId: source.guestId,
              type: source.type,
              currency: source.currency,
              payerName: names[i],
            },
          })
        );
      }

      const folios = [updatedSource, ...created];
      const targets = folios.map((f, i) => ({ folioId: f.id, share: shares[i] }));
      const folioNumbers = Object.fromEntries(folios.map((f) => [f.id, f.folioNumber]));
      const payerNames = Object.fromEntries(folios.map((f) => [f.id, f.payerName]));

      const rows = planSplit({
        transactions: source.transactions,
        targets,
        folioNumbers,
        payerNames,
        sourceFolioId: source.id,
      });

      const transactions = [];
      for (const data of rows) {
        transactions.push(
          await px.folioTransaction.create({
            data: {
              ...data,
              postedBy: req.user?.username || req.user?.sub,
              // 'split' rather than 'transfer' so the audit trail can tell a
              // proportional split from a manual one-line move.
              sourceSystem: 'split',
            },
          })
        );
      }
      return { folios, transactions };
    });

    // The channel the manual transfer already publishes and the web live-refresh
    // layer already forwards. A split has nothing to say that this does not
    // already mean, and a new channel would mean editing the inventory service's
    // LIVE_CHANNELS, useLiveEvents.js and notifications.js in step.
    redis.publish(
      'folio:transferred',
      JSON.stringify({
        fromFolioId: source.id,
        toFolioId: out.folios
          .slice(1)
          .map((f) => f.id)
          .join(','),
        stayId: source.stayId,
        split: true,
      })
    );

    res.status(201).json({
      folios: out.folios.map((f) => ({
        id: f.id,
        folioNumber: f.folioNumber,
        payerName: f.payerName,
      })),
      transactionCount: out.transactions.length,
      payers: previewFor(out.folios.map((f) => f.folioNumber)),
    });
  } catch (err) {
    console.error('[Folio] Split error:', err.message);
    // planSplit throws on a target set that cannot describe a split. That is a
    // bad request, not a server fault, and saying so is more use than a 500.
    if (/at least two|source folio|share/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/folios/:id/payment-intents — generate a QR code for a simulated
// wallet payment. The client asked whether payment could be simulated this way.
//
// Nothing here touches real payment rails: a simulated e-wallet is exactly as valid
// as the simulated card payments this system already takes. The teaching value is
// in what happens next — confirming publishes to Redis, so the front-desk screen
// updates the moment the payment lands, which is the part students need to see.
router.post('/folios/:id/payment-intents', requireRole(...CASHIER), async (req, res) => {
  try {
    let amountCents;
    try {
      amountCents = BigInt(req.body?.amountCents ?? 0);
    } catch {
      return res.status(400).json({ error: 'amountCents must be a whole number of centavos.' });
    }
    if (amountCents <= 0n) return res.status(400).json({ error: 'A payment amount is required.' });

    // A QR code is scanned into an e-wallet app, so only e-wallet-flavoured
    // methods make sense here — this was previously accepted from the client
    // (ReservationDetail.jsx's "Send Pay by Link" dialog) and silently
    // dropped, so every intent was QR_WALLET regardless of what the desk
    // picked. GCash and Maya are now real, distinct choices.
    const QR_METHODS = ['QR_WALLET', 'GCASH', 'MAYA'];
    const method = req.body?.method || 'QR_WALLET';
    if (!QR_METHODS.includes(method)) {
      return res.status(400).json({ error: `method must be one of: ${QR_METHODS.join(', ')}.` });
    }

    const folio = await prisma.folio.findUnique({ where: { id: req.params.id } });
    if (!folio) return res.status(404).json({ error: 'Folio not found.' });
    if (folio.status !== 'OPEN') return res.status(409).json({ error: 'This folio is not open.' });

    // Present only when this intent is meant to be EMAILED rather than scanned
    // in person — "Sent Pay by Link". A longer TTL and a `sentTo` record follow
    // from that one distinction.
    const to = req.body?.to || null;

    const intent = await prisma.paymentIntent.create({
      data: {
        token: newToken(),
        folioId: folio.id,
        amountCents,
        method,
        expiresAt: new Date(Date.now() + (to ? LINK_TTL_MS : INTENT_TTL_MS)),
        createdBy: req.user?.username || req.user?.sub,
        sentTo: to,
      },
    });

    const url = publicUrl(`/pay/${intent.token}`);

    if (to) {
      await sendMail({
        to,
        subject: `Complete your payment — InnSight Hotel`,
        body: [
          `Hi,`,
          '',
          `Please use the link below to pay ${(Number(intent.amountCents) / 100).toFixed(2)} PHP:`,
          url,
          '',
          `This link expires ${intent.expiresAt.toUTCString()}.`,
          '',
          'InnSight Hotel',
        ].join('\r\n'),
      });
    }

    res.status(201).json({
      id: intent.id,
      url,
      expiresAt: intent.expiresAt,
      amountCents: intent.amountCents.toString(),
      qrDataUrl: await qrDataUrl(url),
      // Lets the desk say "scan this" or "confirm on screen" truthfully. A code
      // encoding localhost cannot be opened by a phone — see lib/publicUrl.js.
      scannable: publicUrl.isScannableByPhone,
      ...(to && { sent: true, sentTo: to }),
    });
  } catch (err) {
    console.error('[Folio] Payment intent error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/folios/:id/payment-intents — the history behind "Sent Pay by Link":
// every intent ever generated for this folio, in-person QR codes included, so
// the desk can see what has actually gone out and to whom.
router.get('/folios/:id/payment-intents', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const folio = await prisma.folio.findUnique({ where: { id: req.params.id } });
    if (!folio) return res.status(404).json({ error: 'Folio not found.' });

    const rows = await prisma.paymentIntent.findMany({
      where: { folioId: folio.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(
      rows.map((r) => ({
        id: r.id,
        amountCents: r.amountCents.toString(),
        method: r.method,
        status: intentState(r),
        sentTo: r.sentTo || null,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        confirmedAt: r.confirmedAt,
      }))
    );
  } catch (err) {
    console.error('[Folio] List payment intents error:', err.message);
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

// The guest-portal link for a stay, or null when there is nothing to link to. A QR
// leading to "Not found" is worse than no QR, so this never guesses a URL.
function portalLinkFor(stay) {
  const ref = stay?.confirmationNumber || stay?.reservation?.confirmationNumber;
  return ref ? publicUrl(`/portal/${encodeURIComponent(ref)}`) : null;
}

// The receipt PDF, as a PDFDocument the caller pipes or collects. Shared by the
// download route and the email route so the printed copy and the emailed copy can
// never drift apart.
async function renderReceiptPdf(model, { portalLink } = {}) {
  const money = (cents) => `${model.currency} ${(Number(cents) / 100).toFixed(2)}`;
  const fmtDateTime = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—');
  const doc = new PDFDocument({ size: 'A4', margin: 48 });

  // Same accent the web app itself uses (styles.css's --accent/--accent-soft,
  // light theme) — a printed receipt that carries the product's own color
  // reads as a real document from this property, not a generic template.
  const ACCENT = '#0a6b3d';
  const ACCENT_SOFT = '#d5eee2';
  const INK = '#1a1a1a';
  const MUTED = '#666';

  const M = 48;
  const W = doc.page.width - M * 2;

  // ── Header band ── fixed height, so the QR (which pdfkit can't position
  // relative to text it hasn't drawn yet) always lands inside it regardless
  // of how many detail rows follow below.
  const HEADER_H = 100;
  doc.rect(M, M, W, HEADER_H).fill(ACCENT_SOFT);
  // Heights computed and accumulated by hand, NOT read back from doc.y after
  // each draw: pdfkit only advances doc.y reliably the first time a text call
  // lands away from wherever the cursor already was — chaining doc.y+n across
  // calls at different font sizes left every line after the first stacked on
  // top of the one before it (verified empirically while building this).
  let hy = M + 16;
  const titleText = 'InnSight PMS';
  doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(22);
  doc.text(titleText, M + 16, hy, { width: W - 32, lineBreak: false });
  hy += doc.heightOfString(titleText, { width: W - 32 }) + 3;

  const subtitleText = 'Payment Receipt';
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(12);
  doc.text(subtitleText, M + 16, hy, { lineBreak: false });
  hy += doc.heightOfString(subtitleText) + 3;

  // Says plainly what this document is. A training system that prints
  // something indistinguishable from a BIR official receipt is teaching the
  // wrong lesson.
  const disclaimerText = 'Simulation — not a BIR-registered official receipt.';
  doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8);
  doc.text(disclaimerText, M + 16, hy, { lineBreak: false });

  // The guest's digital copy, when this folio belongs to a booking worth
  // linking to — sits in the header's own corner, so its position never
  // depends on how many detail rows this particular receipt ends up with.
  if (portalLink) {
    try {
      const qrSize = 64;
      const qrX = M + W - qrSize - 12;
      doc.image(await qrPngBuffer(portalLink), qrX, M + 12, { width: qrSize });
      doc
        .font('Helvetica')
        .fontSize(6)
        .fillColor(MUTED)
        .text('Scan for a digital copy', qrX - 8, M + 12 + qrSize + 2, {
          width: qrSize + 16,
          align: 'center',
        });
    } catch (err) {
      // Never fail a guest's proof of payment over the convenience code on it.
      console.error('[Folio] Receipt QR render failed:', err.message);
    }
  }

  doc.y = M + HEADER_H + 20;
  doc.fillColor(INK).fontSize(10);

  // Two real columns at fixed x positions, rather than one continued text flow.
  // The `continued: true` idiom the other PDF routes use makes the label's width
  // constrain the VALUE too, so a long value wraps mid-string: the receipt number
  // broke across two lines and "2026-09-04 14:11" split after the date. Folio
  // numbers here are timestamp-based and genuinely long, so this has to hold.
  const LABEL_X = M + 16;
  const VALUE_X = M + 150;
  const row = (label, value) => {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text(label.toUpperCase(), LABEL_X, y, {
      width: 116,
      lineBreak: false,
      characterSpacing: 0.3,
    });
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(INK)
      .text(String(value ?? '—'), VALUE_X, y, { width: M + W - VALUE_X });
    doc.y += 4;
  };

  row('Receipt No.:', model.receiptNumber);
  row('Folio No.:', model.folioNumber);
  row('Received From:', model.guestName);
  row('Date Received:', fmtDateTime(model.paidAt));
  row('Payment Method:', model.method);
  // Whatever gateway/bank metadata this payment actually carries — printed as
  // proof of what was verified, not just that money changed hands. Only the
  // block for the method this payment actually used ever has anything to
  // show; the other stays entirely absent rather than printing empty rows.
  if (model.card) {
    if (model.card.masked) row('Card:', model.card.masked);
    if (model.card.cardholderName) row('Cardholder:', model.card.cardholderName);
  }
  if (model.bankTransfer) {
    if (model.bankTransfer.bankName) {
      row(
        'Bank:',
        model.bankTransfer.transferNetwork
          ? `${model.bankTransfer.bankName} (${model.bankTransfer.transferNetwork})`
          : model.bankTransfer.bankName
      );
    }
    if (model.bankTransfer.senderName) row('Sender:', model.bankTransfer.senderName);
    if (model.bankTransfer.transferredAt) row('Transferred:', fmtDateTime(model.bankTransfer.transferredAt));
  }
  if (model.gatewayRef) row('Transaction Ref.:', model.gatewayRef);

  // A perforated "tear line" between the detail rows and the amount — a cheap
  // visual cue borrowed from a real receipt slip, drawn with the accent so it
  // doesn't read as a stray horizontal rule.
  doc.y += 8;
  doc
    .dash(2, { space: 3 })
    .moveTo(M, doc.y)
    .lineTo(M + W, doc.y)
    .strokeColor(ACCENT)
    .lineWidth(1)
    .stroke();
  doc.undash();
  doc.y += 16;

  // ── Amount Paid — the one figure this document exists to prove, set apart
  // in its own filled panel rather than just a bigger font size. ──
  const boxY = doc.y;
  const boxH = model.refunded ? 74 : 58;
  doc.roundedRect(M, boxY, W, boxH, 6).fill(ACCENT_SOFT);
  doc
    .fillColor(ACCENT)
    .font('Helvetica-Bold')
    .fontSize(9)
    .text('AMOUNT PAID', M + 16, boxY + 10, { characterSpacing: 0.5, lineBreak: false });
  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(20)
    .text(money(model.paidCents), M + 16, boxY + 22, { lineBreak: false });
  doc
    .fillColor(MUTED)
    .font('Helvetica-Oblique')
    .fontSize(8.5)
    .text(model.paidInWords, M + 16, boxY + 46, { width: W - 32 });

  if (model.refunded) {
    doc
      .fillColor('#b8382c')
      .font('Helvetica-Bold')
      .fontSize(10)
      .text('THIS PAYMENT HAS BEEN REFUNDED', M + 16, boxY + 58, { characterSpacing: 0.3, lineBreak: false });
  }
  doc.y = boxY + boxH + 28;

  // A drawn line, not underscores — the signature sits ON it rather than
  // floating above a row of text characters.
  const sigW = 220;
  doc
    .moveTo(LABEL_X, doc.y)
    .lineTo(LABEL_X + sigW, doc.y)
    .strokeColor('#999')
    .lineWidth(0.75)
    .stroke();
  doc.fillColor(MUTED).font('Helvetica').fontSize(9).text('Received by', LABEL_X, doc.y + 4, { lineBreak: false });

  doc
    .fillColor(MUTED)
    .font('Helvetica')
    .fontSize(8)
    .text('Thank you for staying with us.', M, doc.page.height - M - 20, { width: W, align: 'center' });

  return doc;
}

// Collect a PDFDocument into a Buffer, for attaching to an email.
function pdfToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// GET /api/folios/:id/payments/:paymentId/receipt — proof that ONE payment was
// received, as a PDF the front desk can print or hand over.
//
// Distinct from /folios/:id/print, which renders the whole folio: a guest paying a
// deposit at reservation time has no folio worth printing yet, but does need
// something showing what they handed over. The client asked for exactly this.
router.get(
  '/folios/:id/payments/:paymentId/receipt',
  requireRole(...ROLE_GROUPS.DESK_AUDIT),
  async (req, res) => {
    try {
      const folio = await prisma.folio.findUnique({ where: { id: req.params.id } });
      if (!folio) return res.status(404).json({ error: 'Folio not found.' });

      const payment = await prisma.payment.findUnique({ where: { id: req.params.paymentId } });
      // The folioId check is not redundant: without it, any payment id could be
      // receipted against any folio, putting one guest's payment on another's paper.
      if (!payment || payment.folioId !== folio.id) {
        return res.status(404).json({ error: 'Payment not found on this folio.' });
      }

      const stay = folio.stayId
        ? await fetchJsonOrNull(`${STAY_URL}/api/stays/${encodeURIComponent(folio.stayId)}`)
        : null;
      const guest = folio.guestId
        ? await fetchJsonOrNull(`${GUEST_URL}/api/guests/${encodeURIComponent(folio.guestId)}`)
        : null;
      const guestName = stay?.guestName || guest?.displayName || null;

      let model;
      try {
        model = receiptModel(payment, folio, guestName);
      } catch (err) {
        // A voided or failed payment is a 409, not a 500 — the request was
        // well-formed, the payment is simply not receiptable.
        return res.status(409).json({ error: err.message });
      }

      const doc = await renderReceiptPdf(model, { portalLink: portalLinkFor(stay) });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="receipt-${model.receiptNumber}.pdf"`);
      doc.pipe(res);
      doc.end();
    } catch (err) {
      console.error('[Folio] Receipt error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
    }
  }
);

// POST /api/folios/:id/payments/:paymentId/receipt/email — send the receipt to the
// guest as a PDF attachment. The client asked for receipts to be emailable.
//
// Honest about what this is: SMTP points at Mailhog, which CAPTURES mail and never
// delivers it. That is right for a classroom — nobody wants a training exercise
// mailing real guests — but it means "sent" here means "visible at :8025", and the
// response says so rather than implying delivery.
router.post('/folios/:id/payments/:paymentId/receipt/email', requireRole(...CASHIER), async (req, res) => {
  try {
    const folio = await prisma.folio.findUnique({ where: { id: req.params.id } });
    if (!folio) return res.status(404).json({ error: 'Folio not found.' });

    const payment = await prisma.payment.findUnique({ where: { id: req.params.paymentId } });
    if (!payment || payment.folioId !== folio.id) {
      return res.status(404).json({ error: 'Payment not found on this folio.' });
    }

    const stay = folio.stayId
      ? await fetchJsonOrNull(`${STAY_URL}/api/stays/${encodeURIComponent(folio.stayId)}`)
      : null;
    const guest = folio.guestId
      ? await fetchJsonOrNull(`${GUEST_URL}/api/guests/${encodeURIComponent(folio.guestId)}`)
      : null;

    // An explicit `to` lets the desk send to a company payer who is not the guest —
    // the split-bill case — but the guest's own address is the default.
    const contacts = guest?.contacts || [];
    const emails = contacts.filter((c) => String(c.type).toUpperCase() === 'EMAIL' && c.value);
    const to = req.body?.to || emails.find((c) => c.isPrimary)?.value || emails[0]?.value;
    if (!to) {
      // 400, not 500, and it names the reason: the desk needs to know the guest has
      // no address on file rather than watching a send silently do nothing.
      return res
        .status(400)
        .json({ error: 'No email address on file for this guest. Add one, or pass `to`.' });
    }

    let model;
    try {
      model = receiptModel(payment, folio, stay?.guestName || guest?.displayName || null);
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }

    const pdf = await pdfToBuffer(await renderReceiptPdf(model, { portalLink: portalLinkFor(stay) }));
    await sendMail({
      to,
      subject: `Receipt ${model.receiptNumber} — InnSight Hotel`,
      body: [
        `Dear ${model.guestName},`,
        '',
        `Thank you. We have received ${model.currency} ${(Number(model.paidCents) / 100).toFixed(2)} by ${model.method}.`,
        `Your receipt (${model.receiptNumber}) is attached.`,
        '',
        'InnSight Hotel',
      ].join('\r\n'),
      attachment: {
        filename: `receipt-${model.receiptNumber}.pdf`,
        contentType: 'application/pdf',
        content: pdf,
      },
    });

    res.status(202).json({ sent: true, to, receiptNumber: model.receiptNumber });
  } catch (err) {
    console.error('[Folio] Receipt email error:', err.message);
    res.status(502).json({ error: 'Could not send the receipt email.' });
  }
});

// Builds the structured print model for one folio — the part staff printing
// and the public QR link both need. Pulled out of the /print route so the
// public route below can produce the identical document from just a token,
// without a second copy of this cross-service assembly.
async function buildFolioPrintModel(folio) {
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

  // The other folios on this stay, so a split folio's Remark line can name the
  // co-payers it shares the bill with. Only fetched when this folio actually
  // carries transfers: an ordinary folio prints a blank Remark exactly as it
  // always has, and pays no query for the privilege.
  const counterparts =
    folio.stayId && transactions.some((t) => t.type === 'TRANSFER')
      ? (
          await prisma.folio.findMany({
            where: { stayId: folio.stayId, id: { not: folio.id } },
            select: { id: true, folioNumber: true, payerName: true },
            orderBy: { openedAt: 'asc' },
          })
        ).map((f) => ({ folioId: f.id, folioNumber: f.folioNumber, payerName: f.payerName }))
      : [];

  return folioPrintModel({
    folio,
    transactions,
    summary,
    guest,
    stay,
    reservation,
    hotel: await getHotel(),
    counterparts,
  });
}

// The credential behind the folio's QR code. Generated lazily on first print
// rather than at folio creation — most folios are never scanned or split, and
// no earlier code path should be required to remember to set this. 24 random
// bytes makes guessing it as infeasible as guessing a PaymentIntent token.
async function ensurePublicToken(folio) {
  if (folio.publicToken) return folio.publicToken;
  const token = crypto.randomBytes(24).toString('base64url');
  const updated = await prisma.folio.update({ where: { id: folio.id }, data: { publicToken: token } });
  return updated.publicToken;
}

// Renders a print model to a PDF response — shared by the staff route and the
// public one below, so a scanned code and a staff printout are byte-for-byte
// the same document.
async function renderFolioPdf(res, model, { filename, qrUrl } = {}) {
  // The reference prints amounts as "25,350.00 P".
  const money = (cents) =>
    `${(Number(cents) / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} P`;

  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${filename || `folio-${model.meta.folioNumber}.pdf`}"`
  );
  doc.pipe(res);

  const L = 36; // left margin
  const R = doc.page.width - 36; // right margin
  const W = R - L;
  const SPLIT = L + W * 0.72; // where the Particular column ends
  const TOP = 36; // where a continuation page starts
  // The lowest y a block may occupy. Everything below is drawn at ABSOLUTE
  // coordinates while this route advances its own `y`, so pdfkit's automatic
  // pagination must never be allowed to fire: it starts a page and resets
  // only ITS cursor, leaving `y` still climbing, so every subsequent draw
  // spilled again and each extra row cost several pages. Every block asks
  // reserve() first instead.
  const BOTTOM = doc.page.height - 36;

  const rowH = 16;
  const lineH = 13;
  const AMOUNT_COL = SPLIT - 130;

  // ── QR code, upper right — the panel's reference invoice leaves this corner
  // blank for one. It resolves to the public print route below, so scanning it
  // (no login needed) opens the exact same document as the one being printed.
  if (qrUrl) {
    const qrSize = 68;
    doc.image(await qrPngBuffer(qrUrl), R - qrSize, 34, { width: qrSize, height: qrSize });
  }

  // ── Hotel header ──
  doc.font('Helvetica-Bold').fontSize(15).text(model.hotel.name, L, 40, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(8);
  for (const line of [
    model.hotel.address,
    [
      model.hotel.phone && `Phone: ${model.hotel.phone}`,
      model.hotel.fax && `Fax: ${model.hotel.fax}`,
      model.hotel.email && `E-Mail: ${model.hotel.email}`,
    ]
      .filter(Boolean)
      .join(' ; '),
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
      width: w - 8,
      align: opts.align || 'left',
      lineBreak: false,
    });
  };

  let y = doc.y;

  // ── Pagination helpers ────────────────────────────────────────────────
  // `bodyTop` is the top of the CURRENT page's Particular/Total grid. That
  // grid is bounded by two full-height column rules, so they have to be
  // closed off at the foot of the page being left and reopened underneath
  // the repeated column header on the next one — hence the `inBody` flag
  // rather than a bare addPage().
  let bodyTop = null;

  const closeBodyRules = () => {
    if (bodyTop === null || y <= bodyTop) return;
    doc.rect(L, bodyTop, SPLIT - L, y - bodyTop).stroke();
    doc.rect(SPLIT, bodyTop, R - SPLIT, y - bodyTop).stroke();
  };

  const columnHeader = () => {
    cell(L, y, SPLIT - L, rowH + 2, 'Particular', { bold: true, size: 10, dy: 5 });
    cell(SPLIT, y, R - SPLIT, rowH + 2, 'Total', { bold: true, size: 10, dy: 5, align: 'right' });
    y += rowH + 2;
  };

  // Every continuation page names its folio and says it is a continuation:
  // loose sheets of one guest's bill are otherwise indistinguishable from
  // another guest's.
  const newPage = ({ inBody = false } = {}) => {
    if (inBody) closeBodyRules();
    doc.addPage();
    y = TOP;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .text(`${model.hotel.name} — Folio No. ${model.meta.folioNumber} — continued`, L, y, {
        width: W,
        align: 'center',
        lineBreak: false,
      });
    y += 16;
    bodyTop = null;
    if (inBody) {
      columnHeader();
      bodyTop = y;
    }
  };

  // Claim `h` points for the block about to be drawn, starting a new page if
  // it will not fit. A block that must not be split passes its WHOLE height.
  const reserve = (h, opts) => {
    if (y + h > BOTTOM) newPage(opts);
  };

  // ── Guest / stay grid ──
  cell(L, y, W * 0.55, rowH, 'Folio No.', { bold: true });
  cell(L + W * 0.55, y, W * 0.45, rowH, `Date  :  ${model.meta.date}`, { bold: true });
  doc
    .font('Helvetica')
    .fontSize(8)
    .text(`:  ${model.meta.folioNumber}`, L + 90, y + 4, { lineBreak: false });
  y += rowH;

  cell(L, y, W, rowH, 'Guest Name', { bold: true });
  doc
    .font('Helvetica')
    .fontSize(8)
    .text(`:  ${model.meta.guestName}`, L + 90, y + 4, { lineBreak: false });
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

  // ── Particular / Total grid ──
  // The column header only earns its place if a heading and a row can follow
  // it on the same page.
  reserve(rowH + 2 + lineH * 2);
  columnHeader();
  bodyTop = y;

  for (const section of model.sections) {
    // A section heading is never the last thing on a page: it is drawn only
    // where its first row fits underneath it.
    reserve(lineH * 2, { inBody: true });
    doc
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .text(section.title, L + 4, y + 2, { lineBreak: false });
    y += lineH;
    // The label column stops 8pt short of AMOUNT_COL rather than the old fixed
    // 200 — a description/reference long enough to reach the amount used to
    // run straight into it with lineBreak:false. Wrapping and measuring each
    // row's real height first means a long row grows the row instead of
    // overflowing it, and the page-break check below sees that real height.
    const LABEL_X = L + 20;
    const LABEL_W = AMOUNT_COL - LABEL_X - 8;
    let lastRowHeight = lineH;
    for (const row of section.rows) {
      const label = row.label || '';
      doc.font('Helvetica').fontSize(8);
      const rowHeight = Math.max(lineH, doc.heightOfString(label, { width: LABEL_W }) + 3);
      if (y + rowHeight > BOTTOM) {
        newPage({ inBody: true });
        // A section long enough to run over repeats its own heading, so no
        // row is ever orphaned from the section it belongs to.
        doc
          .font('Helvetica-Bold')
          .fontSize(8.5)
          .text(`${section.title} (continued)`, L + 4, y + 2, { lineBreak: false });
        y += lineH;
      }
      doc.font('Helvetica').fontSize(8);
      // The amount stays pinned to the row's top line, matching how a wrapped
      // line item reads on a printed invoice — only the label grows downward.
      doc.text(label, LABEL_X, y + 2, { width: LABEL_W });
      doc.text(money(row.amountCents), AMOUNT_COL, y + 2, { width: 110, align: 'right', lineBreak: false });
      y += rowHeight;
      lastRowHeight = rowHeight;
    }
    // The section subtotal sits in the right-hand rail, as in the reference.
    // It is drawn level with the section's LAST row (whatever height that row
    // actually grew to), so it is on that row's page by construction and
    // cannot be stranded by itself.
    doc.font('Helvetica').fontSize(8);
    doc.text(money(section.subtotalCents), SPLIT + 4, y - lastRowHeight + 2, {
      width: R - SPLIT - 8,
      align: 'right',
      lineBreak: false,
    });
    y += 3;
  }

  // Column rules for the final page's body block.
  closeBodyRules();
  bodyTop = null;

  // ── Totals rail ──
  // Reserved as ONE block: Total Charges / Total Payment / Balance split
  // over a page boundary reads as two different bills.
  reserve(rowH * 3);
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
  const noticeText =
    'NOTICE TO GUESTS: This property is privately owned and the management reserves the right to refuse ' +
    'service to anyone. Management will not be responsible for accidents or injury to guests or for loss ' +
    'of money, jewelry or valuables of any kind. Management will not be responsible for any item left in ' +
    'the room.';
  const checkoutText = 'CHECKOUT TIME: 11:00 AM        SELF REGISTRATION ONLY';
  const agreeText =
    'I AGREE that my liability for this bill is not waived and agree to be held personally liable in the ' +
    'event that the indicated person or company failed to pay for any part or full amount of these ' +
    'charges. I agree that if an attorney is retained to collect these charges, I will pay all reasonable ' +
    "attorney's fees and costs incurred. I agree that the sole purpose of renting this room is for my own " +
    'residency only.';

  // Measured, not guessed. Two reservations, not one: the five boxed lines
  // (Remark / currency / Bill To / Address / amount in words) are the part
  // that must not be split, and they are claimed as a block. The notice and
  // terms paragraphs below them are static boilerplate — reserving them
  // TOGETHER with the boxed lines would cost ~110pt of the first page for
  // text nobody reads against a figure, and this document already fills
  // nearly a page at zero transactions.
  doc.font('Helvetica').fontSize(7);
  const termsH =
    doc.heightOfString(noticeText, { width: W }) +
    doc.heightOfString(checkoutText, { width: W }) +
    doc.heightOfString(agreeText, { width: W }) +
    16;
  reserve(rowH * 5 + 8);

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

  reserve(termsH);
  doc.font('Helvetica').fontSize(7).fillColor('#000');
  doc.text(noticeText, L, y, { width: W, align: 'left' });
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').text(checkoutText, { width: W });
  doc.font('Helvetica').text(agreeText, { width: W, align: 'justify' });

  doc.end();
}

// GET /api/folios/:id/print — the guest folio as a PDF, laid out to match the
// panel's reference invoice: a bordered grid with every section always present.
//
// The arithmetic lives in lib/folioPrintModel.js and the model-building in
// buildFolioPrintModel above, so this route only wires the two together.
router.get('/folios/:id/print', requireRole(...ROLE_GROUPS.DESK_AUDIT), async (req, res) => {
  try {
    const folio = await prisma.folio.findUnique({
      where: { id: req.params.id },
      include: { transactions: { orderBy: { postedAt: 'asc' } } },
    });
    if (!folio) return res.status(404).json({ error: 'Not found.' });

    const model = await buildFolioPrintModel(folio);
    const token = await ensurePublicToken(folio);
    await renderFolioPdf(res, model, {
      filename: `folio-${folio.folioNumber}.pdf`,
      qrUrl: publicUrl(`/api/public/folios/${token}/pdf`),
    });
  } catch (err) {
    console.error('[Folio] Print error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET/POST /api/public/payment-intents/:token[/confirm] — opened by whatever
// scanned a QR code: a phone with no login, or a second browser window in a
// classroom demo. The intent token IS the credential — 32 random bytes,
// single use, short-lived (see lib/paymentIntent.js).
//
// Deliberately minimal in what GET returns. A stranger who guesses a token
// learns the amount and the hotel name, never the guest, the room or the
// folio contents.
publicRouter.get('/payment-intents/:token', async (req, res) => {
  try {
    const intent = await prisma.paymentIntent.findUnique({ where: { token: req.params.token } });
    if (!intent) return res.status(404).json({ error: 'This payment link is not valid.' });
    res.json({
      state: intentState(intent),
      amountCents: intent.amountCents.toString(),
      currency: 'PHP',
      method: intent.method,
      expiresAt: intent.expiresAt,
    });
  } catch (err) {
    console.error('[Folio] Public intent read error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

publicRouter.post('/payment-intents/:token/confirm', async (req, res) => {
  try {
    const intent = await prisma.paymentIntent.findUnique({ where: { token: req.params.token } });
    if (!intent) return res.status(404).json({ error: 'This payment link is not valid.' });

    const state = intentState(intent);
    if (state !== 'PENDING') {
      // 409 with the actual state, so the page can say "already paid" or "expired"
      // rather than a generic failure the student cannot act on.
      return res.status(409).json({ error: `This payment link is ${state.toLowerCase()}.`, state });
    }

    // Interactive transaction (not the array form) so the ledger row below can
    // carry the Payment's own id as ITS reference — every other
    // payment-posting route in this service does the same (see POST
    // /folios/:id/payments): postRefund() looks the Payment row back up via
    // `payment.updateMany({ where: { id: original.reference } })`, so this
    // reference MUST stay Payment.id, never the human-facing gatewayRef —
    // this route used to set it to gatewayRef instead, which quietly broke
    // that lookup for every QR-paid folio (a refund would post fine on the
    // ledger but silently fail to flip the underlying Payment row REFUNDED).
    // Flipping the intent to CONFIRMED in the SAME transaction as the payment
    // is what makes a double scan safe: the second one finds it already
    // confirmed and stops, instead of posting twice.
    const payment = await prisma.$transaction(async (px) => {
      await px.paymentIntent.update({
        where: { id: intent.id, status: 'PENDING' },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      });
      const p = await px.payment.create({
        data: {
          folioId: intent.folioId,
          method: intent.method,
          amountCents: intent.amountCents,
          status: 'CAPTURED',
          gatewayRef: `SIM-${intent.id.slice(-12)}`,
        },
      });
      await px.folioTransaction.create({
        data: {
          folioId: intent.folioId,
          type: 'PAYMENT',
          description: `Payment via ${intent.method} (simulated)`,
          amountCents: intent.amountCents,
          paymentMethod: intent.method,
          sourceSystem: 'qr-simulation',
          reference: p.id,
        },
      });
      return p;
    });

    // What makes this worth demonstrating: the front-desk screen updates itself.
    redis.publish(
      // The established folio channel, not a new 'payment:received': every page
      // that declares the folio domain is already subscribed to this one, and the
      // SSE gateway only forwards whitelisted channels.
      'folio:payment_received',
      JSON.stringify({
        folioId: intent.folioId,
        paymentId: payment.id,
        amountCents: intent.amountCents.toString(),
      })
    );

    // The reference rides back to whichever phone scanned the code, so the
    // guest has something to point to ("SIM-xxxxxxxxxxxx") if the charge is
    // ever disputed — not just a checkmark that vanishes when the tab closes.
    res.json({
      state: 'CONFIRMED',
      amountCents: intent.amountCents.toString(),
      reference: payment.gatewayRef,
    });
  } catch (err) {
    // A lost race on the status guard lands here: the row was PENDING when read and
    // CONFIRMED by the time it was updated. That is a double scan, not an outage.
    if (err.code === 'P2025') {
      return res.status(409).json({ error: 'This payment has already been made.', state: 'CONFIRMED' });
    }
    console.error('[Folio] Public confirm error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/public/folios/:token/pdf — what the QR code on the printed folio
// resolves to. Unauthenticated: the token is the credential, exactly like a
// PaymentIntent link above (see index.js, which mounts this before verifyToken).
// Deliberately does NOT mint a token for a folio that doesn't have one — only
// a folio that has actually been printed at least once is reachable this way,
// so a guessed id can never be turned into a valid link.
publicRouter.get('/folios/:token/pdf', async (req, res) => {
  try {
    const folio = await prisma.folio.findUnique({
      where: { publicToken: req.params.token },
      include: { transactions: { orderBy: { postedAt: 'asc' } } },
    });
    if (!folio) return res.status(404).json({ error: 'This folio link is not valid.' });

    const model = await buildFolioPrintModel(folio);
    await renderFolioPdf(res, model, {
      filename: `folio-${folio.folioNumber}.pdf`,
      qrUrl: publicUrl(`/api/public/folios/${folio.publicToken}/pdf`),
    });
  } catch (err) {
    console.error('[Folio] Public print error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
module.exports.publicRouter = publicRouter;
