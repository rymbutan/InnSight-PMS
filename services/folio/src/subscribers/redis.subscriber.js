const Redis = require('ioredis');

const prisma = require('../lib/prisma');
const { signServiceToken } = require('../middleware/auth');
const publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const RESERVATION_URL = process.env.RESERVATION_URL || 'http://reservation-service:3011';
const SERVICE_TIMEOUT_MS = Number(process.env.SERVICE_TIMEOUT_MS || 8000);

function nextFolioNumber() {
  return `F-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function serviceToken() {
  return signServiceToken({
    name: 'folio',
    roles: ['MANAGER'],
    permissions: ['reservation.read'],
    expiresIn: '2m',
  });
}

// Best-effort — a failed lookup means no add-on charges post for this
// check-in rather than the check-in event handler crashing.
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

          // Post any reservation add-ons (Changes-to-be-made doc, item 4) now
          // that a folio exists to charge them to. Reference-keyed and checked
          // before insert so a redelivered event never double-charges — same
          // pattern the night audit uses for its own postings.
          if (data.reservationId) {
            const reservation = await fetchReservationOrNull(data.reservationId);
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
