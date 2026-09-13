const Redis = require('ioredis');

const prisma = require('../lib/prisma');

function startSubscriber() {
  const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  // Separate connection for publishing — a Redis connection in subscriber
  // mode cannot issue PUBLISH commands.
  const publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  // Without an 'error' listener, an ioredis connection error is thrown as an
  // unhandled 'error' event and crashes the whole process on a Redis blip.
  subscriber.on('error', (e) => console.error('[Inventory] subscriber redis error:', e.message));
  publisher.on('error', (e) => console.error('[Inventory] publisher redis error:', e.message));

  // Re-broadcast status transitions that originate from OTHER services
  // (e.g. front-desk checkout → DIRTY) so the live hotel map SSE stream
  // sees them too.
  function broadcastStatus(roomId, status) {
    prisma.room
      .findUnique({ where: { id: roomId } })
      .then((room) => {
        if (!room) return;
        publisher.publish(
          'room:status_changed',
          JSON.stringify({
            roomId: room.id,
            number: room.number,
            status,
          })
        );
      })
      .catch(() => {});
  }

  subscriber.subscribe(
    'reservation:created',
    'reservation:confirmed',
    'reservation:cancelled',
    'reservation:updated',
    'room:checkin',
    'room:checkout',
    'stay:room_changed',
    'maintenance:room_out_of_service',
    'maintenance:room_restored',
    'auth:user_deleted',
    (err) => {
      if (err) {
        console.error('[Inventory] Redis subscribe error:', err);
        return;
      }
      console.log('[Inventory] Redis subscriber active — listening for inventory events.');
    }
  );

  subscriber.on('message', async (channel, message) => {
    try {
      const data = JSON.parse(message);

      if (channel === 'reservation:created' || channel === 'reservation:confirmed') {
        // DELIBERATELY DOES NOT CREATE HOLDS.
        //
        // This handler used to place the inventory hold for every new
        // reservation. That was the root cause of unbounded oversell: it ran
        // asynchronously AFTER the reservation was already committed, and it
        // never compared anything against RoomType.totalInventory — so the real
        // capacity check in POST /api/holds was dead code that nothing called.
        //
        // Capacity is now claimed synchronously and transactionally BEFORE the
        // reservation is inserted (POST /api/holds → attach). See the holds
        // section of routes/inventory.routes.js. Creating a hold here as well
        // would double-count the booking against inventory.
        //
        // Kept as a no-op log so an unattached hold is visible in the logs if a
        // booking ever reaches this point without one.
        if (data.reservationId) {
          const attached = await prisma.inventoryHold.count({
            where: { reservationId: data.reservationId, status: { in: ['ACTIVE', 'COMMITTED'] } },
          });
          if (attached === 0) {
            console.warn(
              `[Inventory] ${channel} for reservation ${data.reservationId} has NO inventory hold — ` +
                'the booking path did not go through POST /api/holds. Capacity is not being tracked for it.'
            );
          }
        }
      }

      if (channel === 'reservation:cancelled') {
        console.log(`[Inventory] Reservation ${data.reservationId} cancelled — releasing holds`);
        await prisma.inventoryHold.updateMany({
          where: { reservationId: data.reservationId, status: { in: ['ACTIVE', 'COMMITTED'] } },
          data: { status: 'RELEASED' },
        });
      }

      if (channel === 'reservation:updated') {
        console.log(`[Inventory] Reservation ${data.reservationId} updated`);
        // Consumers can re-issue holds as needed.
      }

      if (channel === 'room:checkin' && data.roomId) {
        console.log(`[Inventory] Room ${data.roomId} checked in → OCCUPIED`);
        await prisma.room.updateMany({
          where: { id: data.roomId },
          data: { status: 'OCCUPIED' },
        });
        broadcastStatus(data.roomId, 'OCCUPIED');
      }

      if (channel === 'room:checkout' && data.roomId) {
        console.log(`[Inventory] Room ${data.roomId} checked out → DIRTY`);
        await prisma.room.updateMany({
          where: { id: data.roomId },
          data: { status: 'DIRTY' },
        });
        broadcastStatus(data.roomId, 'DIRTY');
      }

      if (channel === 'stay:room_changed') {
        // Free the old room (needs cleaning) and occupy the new one.
        if (data.fromRoomId) {
          await prisma.room.updateMany({ where: { id: data.fromRoomId }, data: { status: 'DIRTY' } });
          broadcastStatus(data.fromRoomId, 'DIRTY');
        }
        if (data.toRoomId) {
          await prisma.room.updateMany({ where: { id: data.toRoomId }, data: { status: 'OCCUPIED' } });
          broadcastStatus(data.toRoomId, 'OCCUPIED');
        }
      }

      if (channel === 'maintenance:room_out_of_service' && data.roomId) {
        console.log(`[Inventory] Room ${data.roomId} out of service`);
        await prisma.room.updateMany({ where: { id: data.roomId }, data: { status: 'OUT_OF_SERVICE' } });
        broadcastStatus(data.roomId, 'OUT_OF_SERVICE');
      }

      if (channel === 'maintenance:room_restored' && data.roomId) {
        console.log(`[Inventory] Room ${data.roomId} restored → DIRTY (needs cleaning)`);
        await prisma.room.updateMany({ where: { id: data.roomId }, data: { status: 'DIRTY' } });
        broadcastStatus(data.roomId, 'DIRTY');
      }
      // A deleted account must not stay named on a room. Unlike the ids on
      // folios and reservations, this one is not history — it says who is
      // working that room NOW, and the desk rings whoever it names. Left stale,
      // it sends a call to a user that no longer exists, which reaches nobody
      // and is only discovered when it rings out 30 seconds later.
      if (channel === 'auth:user_deleted' && data.userId) {
        const cleared = await prisma.room.updateMany({
          where: { assignedTo: data.userId },
          data: { assignedTo: null, assignedToName: null },
        });
        if (cleared.count) {
          console.log(
            `[Inventory] User ${data.userId} deleted — cleared ${cleared.count} room assignment(s).`
          );
        }
      }

      // Note: room cleaning propagates via the direct PATCH /api/rooms/:id/status
      // route (which publishes room:status_changed), so there is no separate
      // housekeeping:room_cleaned channel to consume here.
    } catch (err) {
      console.error('[Inventory] Event handler error:', err.message);
    }
  });

  return subscriber;
}

module.exports = { startSubscriber };
