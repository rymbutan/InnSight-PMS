const Redis = require('ioredis');

const prisma = require('../lib/prisma');

function startSubscriber() {
  const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  subscriber.on('error', (e) => console.error('[Stay] subscriber redis error:', e.message));

  subscriber.subscribe(
    'reservation:confirmed',
    'reservation:cancelled',
    'payment:authorized',
    'folio:created',
    'guest:profile_updated',
    'reservation:updated',
    (err) => {
      if (err) {
        console.error('[Stay] Redis subscribe error:', err);
        return;
      }
      console.log('[Stay] Redis subscriber active — listening for stay events.');
    }
  );

  subscriber.on('message', async (channel, message) => {
    try {
      const data = JSON.parse(message);

      // A booking's dates moved. The Stay carries its own expected window, and
      // it is read in places the reservation is not: the registration card's
      // arrival date, Arrivals' early-check-in confirmation, and the expected
      // column in Reports. Left alone it goes on describing the old dates.
      //
      // expectedCheckIn only follows while the guest has not arrived. Once
      // IN_HOUSE their arrival is a fact, so only the expected departure can
      // still move — which is also what POST /stays/:id/extend does.
      if (channel === 'reservation:updated' && data.reservationId && (data.checkIn || data.checkOut)) {
        const stay = await prisma.stay.findFirst({
          where: {
            reservationId: data.reservationId,
            status: { notIn: ['DEPARTED', 'NO_SHOW'] },
          },
        });
        if (stay) {
          const next = {};
          if (data.checkOut) next.expectedCheckOut = new Date(data.checkOut);
          if (data.checkIn && stay.status === 'PRE_ARRIVAL') {
            next.expectedCheckIn = new Date(data.checkIn);
          }
          // Only write when something actually differs, so an unrelated field
          // edit on the reservation does not churn the stay row.
          const changed = Object.entries(next).some(
            ([k, v]) => new Date(stay[k] || 0).getTime() !== v.getTime()
          );
          if (changed) {
            await prisma.stay.update({ where: { id: stay.id }, data: next });
            console.log(`[Stay] Synced expected window on ${stay.id} from its reservation`);
          }
        }
      }

      // `guestName` on a Stay is a denormalised copy, and it is what the
      // arrivals and housekeeping screens render. A guest renamed on their
      // profile would otherwise stay misspelled on those boards for the whole
      // stay. Only live stays are touched — a DEPARTED or NO_SHOW row records
      // what the guest was called at the time.
      if (channel === 'guest:profile_updated' && data.guestId && data.displayName) {
        const { count } = await prisma.stay.updateMany({
          where: {
            guestId: data.guestId,
            guestName: { not: data.displayName },
            status: { notIn: ['DEPARTED', 'NO_SHOW'] },
          },
          data: { guestName: data.displayName },
        });
        if (count) console.log(`[Stay] Renamed guest ${data.guestId} on ${count} stay(s)`);
      }

      if (channel === 'reservation:confirmed') {
        console.log(`[Stay] Pre-populating arrival for reservation ${data.reservationId}`);
        const existing = await prisma.stay.findFirst({ where: { reservationId: data.reservationId } });
        if (!existing) {
          await prisma.stay.create({
            data: {
              reservationId: data.reservationId,
              guestId: data.guestId,
              guestName: data.guestName,
              expectedCheckIn: data.checkIn ? new Date(data.checkIn) : null,
              expectedCheckOut: data.checkOut ? new Date(data.checkOut) : null,
              status: 'PRE_ARRIVAL',
            },
          });
        }
      }

      if (channel === 'reservation:cancelled' && data.reservationId) {
        // A cancelled reservation should not linger as a PRE_ARRIVAL stay on the
        // arrivals list (nor be checkable-in). Remove the not-yet-arrived stay.
        const result = await prisma.stay.deleteMany({
          where: { reservationId: data.reservationId, status: 'PRE_ARRIVAL' },
        });
        if (result.count)
          console.log(
            `[Stay] Removed ${result.count} PRE_ARRIVAL stay(s) for cancelled reservation ${data.reservationId}`
          );
      }

      if (channel === 'folio:created') {
        console.log(`[Stay] Backfilling folioId for stay ${data.stayId}`);
        if (data.stayId && data.folioId) {
          await prisma.stay
            .updateMany({
              where: { id: data.stayId },
              data: { folioId: data.folioId },
            })
            .catch((e) => console.error('[Stay] folioId backfill failed:', e.message));
        }
      }

      if (channel === 'payment:authorized') {
        console.log(`[Stay] Payment authorized for stay ${data.stayId} — advancing saga`);
        if (data.stayId) {
          const task = await prisma.checkInTask.findFirst({ where: { stayId: data.stayId } });
          if (task) {
            await prisma.checkInTask.update({
              where: { taskId: task.taskId },
              data: { currentStep: 'PAYMENT_AUTHORIZED', stepStatus: 'COMPLETED' },
            });
          }
        }
      }
    } catch (err) {
      console.error('[Stay] Event handler error:', err.message);
    }
  });

  return subscriber;
}

module.exports = { startSubscriber };
