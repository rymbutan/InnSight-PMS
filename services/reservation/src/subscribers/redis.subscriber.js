const Redis = require('ioredis');
const { send, TEMPLATES } = require('../lib/notifier');
const { sendSms, sendViber, logNotification, SMS_TEMPLATES } = require('../lib/notifyChannels');

const prisma = require('../lib/prisma');

// Every channel this booking has an address for gets tried, independently —
// a guest with a phone but a typo'd email should still get their SMS/Viber,
// and vice versa. Each attempt (success or failure) is its own row in
// NotificationLog, so "did the guest actually get their confirmation" has one
// place to look regardless of which channel carried it.
async function notify(template, reservation) {
  if (!reservation) return;

  if (reservation.guestEmail) {
    try {
      const { subject, body } = TEMPLATES[template](reservation);
      await send({ to: reservation.guestEmail, subject, body });
      await logNotification(prisma, {
        reservationId: reservation.id,
        channel: 'EMAIL',
        to: reservation.guestEmail,
        subject,
        body,
      });
      console.log(`[Reservation] sent "${template}" email to ${reservation.guestEmail}`);
    } catch (e) {
      console.warn(`[Reservation] email failed (${template}):`, e.message);
      await logNotification(prisma, {
        reservationId: reservation.id,
        channel: 'EMAIL',
        to: reservation.guestEmail,
        body: '',
        status: 'FAILED',
        error: e.message,
      });
    }
  }

  // SMS and Viber — mocked (see lib/notifyChannels.js). Only dispatched for
  // events that have a text template; not every email TEMPLATES key needs a
  // text-message equivalent.
  const smsBody = SMS_TEMPLATES[template]?.(reservation);
  if (smsBody) {
    await sendSms(prisma, reservation, smsBody);
    await sendViber(prisma, reservation, smsBody);
  }
}

function startSubscriber() {
  const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  // A connection in subscriber mode cannot issue PUBLISH, so re-publishing needs
  // its own connection.
  const publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  subscriber.on('error', (e) => console.error('[Reservation] redis subscriber error:', e.message));
  publisher.on('error', (e) => console.error('[Reservation] redis publisher error:', e.message));

  subscriber.subscribe(
    'room:checkin',
    'stay:no_show',
    'reservation:confirmed',
    'reservation:cancelled',
    'guest:profile_updated',
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
        // Read-then-write, not updateMany: the Terms & Conditions treat a
        // no-show exactly like a <24h cancellation — full forfeiture — and
        // Prisma's `data` object can't set a column to another column's
        // current value (`cancellationFeeCents = totalEstimateCents`) in one
        // updateMany call.
        const existing = await prisma.reservation.findUnique({ where: { id: data.reservationId } });
        if (existing) {
          await prisma.reservation.update({
            where: { id: data.reservationId },
            data: { status: 'NO_SHOW', cancellationFeeCents: existing.totalEstimateCents },
          });
          console.log(`[Reservation] Marked ${data.reservationId} as NO_SHOW (fee forfeited in full)`);
        }
      }

      // A guest was renamed. `guestName` on a reservation is a denormalised copy
      // — it is what the calendar bars, the records list and arrivals render —
      // so a rename that only touched the guest profile left the old name on
      // every one of those screens, permanently. Refreshing the copy is what
      // makes the edit show up where it matters, and re-publishing
      // reservation:updated is what makes those screens notice.
      //
      // Scoped to bookings that are still live: a CHECKED_OUT or CANCELLED
      // reservation is a historical record of what the guest was called at the
      // time, and rewriting it would quietly edit the past.
      if (channel === 'guest:profile_updated' && data.guestId && data.displayName) {
        const touched = await prisma.reservation.findMany({
          where: {
            guestId: data.guestId,
            guestName: { not: data.displayName },
            status: { notIn: ['CANCELLED', 'NO_SHOW', 'CHECKED_OUT'] },
          },
          select: { id: true },
        });
        if (touched.length) {
          await prisma.reservation.updateMany({
            where: { id: { in: touched.map((r) => r.id) } },
            data: { guestName: data.displayName },
          });
          for (const r of touched) {
            publisher.publish('reservation:updated', JSON.stringify({ reservationId: r.id }));
          }
          console.log(
            `[Reservation] Renamed guest ${data.guestId} on ${touched.length} reservation(s)`
          );
        }
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
