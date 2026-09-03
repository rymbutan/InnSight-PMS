const Redis = require('ioredis');
const { send, TEMPLATES } = require('../lib/notifier');

const prisma = require('../lib/prisma');

async function notify(template, reservation) {
  if (!reservation?.guestEmail) return;
  try {
    const { subject, body } = TEMPLATES[template](reservation);
    await send({ to: reservation.guestEmail, subject, body });
    console.log(`[Reservation] sent "${template}" email to ${reservation.guestEmail}`);
  } catch (e) {
    console.warn(`[Reservation] email failed (${template}):`, e.message);
  }
}

function startSubscriber() {
  const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  subscriber.subscribe(
    'room:checkin',
    'stay:no_show',
    'reservation:confirmed',
    'reservation:cancelled',
    (err) => {
      if (err) {
        console.error('[Reservation] Redis subscribe error:', err);
        return;
      }
      console.log('[Reservation] Redis subscriber active.');
    }
  );

  subscriber.on('message', async (channel, message) => {
    try {
      const data = JSON.parse(message);

      if (channel === 'room:checkin' && data.reservationId) {
        await prisma.reservation.updateMany({
          where: { id: data.reservationId },
          data: { status: 'CHECKED_IN' },
        });
        console.log(`[Reservation] Marked ${data.reservationId} as CHECKED_IN`);
      }

      if (channel === 'stay:no_show' && data.reservationId) {
        await prisma.reservation.updateMany({
          where: { id: data.reservationId },
          data: { status: 'NO_SHOW' },
        });
        console.log(`[Reservation] Marked ${data.reservationId} as NO_SHOW`);
      }

      // Outbound emails — fire-and-forget, errors logged but never block.
      if (channel === 'reservation:confirmed' && data.reservationId) {
        const r = await prisma.reservation.findUnique({ where: { id: data.reservationId } });
        notify('reservation_confirmed', r);
      }
      if (channel === 'reservation:cancelled' && data.reservationId) {
        const r = await prisma.reservation.findUnique({ where: { id: data.reservationId } });
        notify('reservation_cancelled', r);
      }
    } catch (err) {
      console.error('[Reservation] Event handler error:', err.message);
    }
  });

  return subscriber;
}

module.exports = { startSubscriber };
