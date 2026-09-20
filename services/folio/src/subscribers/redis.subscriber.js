const Redis = require('ioredis');

const prisma = require('../lib/prisma');
const { signServiceToken } = require('../middleware/auth');
const { localDay } = require('../lib/date');
const { getTaxRates } = require('../lib/settingsStore');
const { computeTax } = require('../lib/policies');
const publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const RESERVATION_URL = process.env.RESERVATION_URL || 'http://reservation-service:3011';
const SERVICE_TIMEOUT_MS = Number(process.env.SERVICE_TIMEOUT_MS || 8000);
// Same code the night audit posts room charges under (audit.routes.js's
// default `roomChargeCode`) — one code, one meaning, whichever side posts it.
const ROOM_CHARGE_CODE = 'RM';

function nextFolioNumber() {
  return `F-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

// Add `n` local calendar days to a 'YYYY-MM-DD' key, without going through a
// timezone-sensitive Date constructor — see lib/date.js's own warning about
// mixing local-day and UTC-day conventions.
function addDaysToDayKey(dayKey, n) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function serviceToken() {
  return signServiceToken({
    name: 'folio',
    roles: ['MANAGER'],
    permissions: ['reservation.read'],
    expiresIn: '2m',
  });
}

// Best-effort — a failed lookup means no room charge or add-on charges post
// for this check-in rather than the check-in event handler crashing.
async function fetchReservationOrNull(reservationId) {
  try {
    const r = await fetch(`${RESERVATION_URL}/api/reservations/${encodeURIComponent(reservationId)}`, {
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${serviceToken()}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (err) {
    console.error(`[Folio] Could not fetch reservation ${reservationId} for add-ons:`, err.message);
    return null;
  }
}

function startSubscriber() {
  const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  subscriber.subscribe('room:checkin', 'room:checkout', 'housekeeping:damage_reported', (err) => {
    if (err) {
      console.error('[Folio] Redis subscribe error:', err);
      return;
    }
    console.log('[Folio] Redis subscriber active — listening for folio events.');
  });

  subscriber.on('message', async (channel, message) => {
    try {
      const data = JSON.parse(message);

      if (channel === 'room:checkin') {
        console.log(`[Folio] Opening folio for stay ${data.stayId}`);
        if (data.stayId) {
          let folio = await prisma.folio.findFirst({ where: { stayId: data.stayId, status: 'OPEN' } });
          const isNew = !folio;
          if (isNew) {
            folio = await prisma.folio.create({
              data: {
                folioNumber: nextFolioNumber(),
                stayId: data.stayId,
                guestId: data.guestId,
                type: 'GUEST',
              },
            });
            // Notify stay service so it can backfill stay.folioId
            await publisher.publish(
              'folio:created',
              JSON.stringify({
                folioId: folio.id,
                folioNumber: folio.folioNumber,
                stayId: folio.stayId,
                guestId: folio.guestId,
              })
            );
          }

          // Post the security/advance deposit collected at check-in (WalkIn.jsx
          // and the Arrivals check-in form both accept one) as a PAYMENT against
          // the folio — the same convention as the pre-arrival deposit route
          // (POST /api/folios/:id/deposit). Without this, a deposit taken at the
          // desk sat only on Stay.depositAmount and never reduced what the guest
          // folio showed as owing. Reference-keyed and checked before insert so
          // a redelivered event never double-posts it.
          const depositAmountCents = Number(data.depositAmount || 0);
          if (depositAmountCents > 0) {
            const reference = `DEPOSIT-CHECKIN-${data.stayId}`;
            const already = await prisma.folioTransaction.findFirst({ where: { reference } });
            if (!already) {
              await prisma.folioTransaction.create({
                data: {
                  folioId: folio.id,
                  type: 'PAYMENT',
                  description: 'Security deposit collected at check-in',
                  amountCents: BigInt(Math.round(depositAmountCents)),
                  postedBy: 'system.stay-checkin',
                  sourceSystem: 'stay',
                  reference,
                },
              });
            }
          }

          if (data.reservationId) {
            const reservation = await fetchReservationOrNull(data.reservationId);

            // Post the ENTIRE stay's room charges immediately at check-in —
            // one line per night, priced at totalEstimateCents/nights each —
            // rather than leaving the folio at 0 until the night audit gets
            // around to charging each night individually. A guest who booked
            // 2 nights at ₱2,800 and checks in on day one sees ₱5,600 owed
            // right away, not ₱0.
            //
            // Each night's reference is `AUDIT-<day>-<stayId>` — EXACTLY what
            // the night audit itself checks before charging that stay for
            // that day (audit.routes.js's `auditRef`) — so when the audit
            // later runs for any of these nights, it finds the charge already
            // posted and skips it. Never a double charge, whether the audit
            // runs before or after check-in.
            //
            // An early departure does not need special-casing here: it is
            // already handled by the existing
            // POST /folios/:id/early-departure-adjustment, which credits back
            // whatever unused nights this posted.
            const nights = reservation?.nights || 1;
            const totalEstimateCents = Number(reservation?.totalEstimateCents || 0);
            const nightlyCents = totalEstimateCents > 0 ? Math.round(totalEstimateCents / nights) : 0;
            if (nightlyCents > 0 && reservation?.checkIn) {
              const cc = await prisma.chargeCode.findUnique({ where: { code: ROOM_CHARGE_CODE } });
              const rates = await getTaxRates();
              let day = localDay(reservation.checkIn);
              for (let i = 0; i < nights; i += 1) {
                const reference = `AUDIT-${day}-${data.stayId}`;
                const already = await prisma.folioTransaction.findFirst({ where: { reference } });
                if (!already) {
                  const { taxCents, breakdown } = computeTax({
                    subtotalCents: nightlyCents,
                    category: cc?.category || 'ROOM',
                    rates,
                  });
                  await prisma.folioTransaction.create({
                    data: {
                      folioId: folio.id,
                      type: 'CHARGE',
                      chargeCode: ROOM_CHARGE_CODE,
                      description: `Room charge for ${day}`,
                      amountCents: BigInt(nightlyCents),
                      taxAmountCents: taxCents,
                      taxBreakdown: breakdown.map((b) => ({ ...b, amountCents: b.amountCents.toString() })),
                      postedBy: 'system.stay-checkin',
                      sourceSystem: 'stay',
                      reference,
                    },
                  });
                }
                day = addDaysToDayKey(day, 1);
              }
            }

            // Post any reservation add-ons (Changes-to-be-made doc, item 4) now
            // that a folio exists to charge them to. Reference-keyed and checked
            // before insert so a redelivered event never double-charges — same
            // pattern the night audit uses for its own postings.
            const addOns = Array.isArray(reservation?.addOns) ? reservation.addOns : [];
            for (let i = 0; i < addOns.length; i += 1) {
              const addOn = addOns[i];
              const reference = `ADDON-${data.reservationId}-${i}`;
              const already = await prisma.folioTransaction.findFirst({ where: { reference } });
              if (already) continue;
              await prisma.folioTransaction.create({
                data: {
                  folioId: folio.id,
                  type: 'CHARGE',
                  chargeCode: 'AO',
                  description: addOn.description,
                  amountCents: BigInt(Math.round(addOn.totalCents)),
                  postedBy: 'system.reservation-addons',
                  sourceSystem: 'reservation',
                  reference,
                },
              });
            }
          } else if (data.walkIn && Number(data.nightlyRateCents) > 0) {
            // A walk-in has no reservationId, so the branch above never runs for
            // it — that was the whole bug: the deposit posted as a PAYMENT
            // above, but the offsetting room CHARGE never did. The rate and
            // night count travel on the check-in event itself (see
            // stay.routes.js's POST /api/walk-in) since there is no reservation
            // to fetch them from. Same per-night loop, same `AUDIT-<day>-<stayId>`
            // reference the night audit checks before charging a stay for that
            // day, so a walk-in that runs through the audit later is never
            // double-charged for a night this already posted.
            const nights = Math.max(1, Math.round(Number(data.nights) || 1));
            const nightlyCents = Math.round(Number(data.nightlyRateCents));
            const cc = await prisma.chargeCode.findUnique({ where: { code: ROOM_CHARGE_CODE } });
            const rates = await getTaxRates();
            let day = localDay(new Date());
            for (let i = 0; i < nights; i += 1) {
              const reference = `AUDIT-${day}-${data.stayId}`;
              const already = await prisma.folioTransaction.findFirst({ where: { reference } });
              if (!already) {
                const { taxCents, breakdown } = computeTax({
                  subtotalCents: nightlyCents,
                  category: cc?.category || 'ROOM',
                  rates,
                });
                await prisma.folioTransaction.create({
                  data: {
                    folioId: folio.id,
                    type: 'CHARGE',
                    chargeCode: ROOM_CHARGE_CODE,
                    description: `Room charge for ${day}`,
                    amountCents: BigInt(nightlyCents),
                    taxAmountCents: taxCents,
                    taxBreakdown: breakdown.map((b) => ({ ...b, amountCents: b.amountCents.toString() })),
                    postedBy: 'system.stay-checkin',
                    sourceSystem: 'stay',
                    reference,
                  },
                });
              }
              day = addDaysToDayKey(day, 1);
            }
          }
        }
      }

      if (channel === 'room:checkout') {
        console.log(`[Folio] Locking folio for stay ${data.stayId}`);
        if (data.stayId) {
          await prisma.folio.updateMany({
            where: { stayId: data.stayId, status: 'OPEN' },
            data: { status: 'LOCKED' },
          });
        }
      }

      if (channel === 'housekeeping:damage_reported') {
        console.log(`[Folio] Damage reported for room ${data.roomId} — posting charge`);
        if (data.stayId) {
          const folio = await prisma.folio.findFirst({ where: { stayId: data.stayId } });
          if (folio) {
            await prisma.folioTransaction.create({
              data: {
                folioId: folio.id,
                type: 'CHARGE',
                chargeCode: 'DM',
                description: `Damage: ${data.description || 'Room damage reported'}`,
                amountCents: BigInt(data.amountCents || 50000),
                sourceSystem: 'housekeeping',
              },
            });
          }
        }
      }
    } catch (err) {
      console.error('[Folio] Event handler error:', err.message);
    }
  });

  return subscriber;
}

module.exports = { startSubscriber };
