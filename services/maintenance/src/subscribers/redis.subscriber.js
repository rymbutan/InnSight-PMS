const Redis = require('ioredis');

const prisma = require('../lib/prisma');
const publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

function nextWoNumber() {
  return `WO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function startSubscriber() {
  const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  subscriber.subscribe(
    'housekeeping:maintenance_required',
    'housekeeping:damage_reported',
    'room:maintenance',
    (err) => {
      if (err) {
        console.error('[Maintenance] Redis subscribe error:', err);
        return;
      }
      console.log('[Maintenance] Redis subscriber active — listening for maintenance events.');
    }
  );

  subscriber.on('message', async (channel, message) => {
    try {
      const data = JSON.parse(message);

      if (channel === 'housekeeping:maintenance_required' || channel === 'housekeeping:damage_reported') {
        console.log(`[Maintenance] Auto-creating WO from ${channel} for room ${data.roomId}`);
        const wo = await prisma.workOrder.create({
          data: {
            workOrderNumber: nextWoNumber(),
            type: 'REACTIVE',
            priority: data.priority || 'NORMAL',
            category: channel === 'housekeeping:damage_reported' ? 'damage' : 'general',
            roomId: data.roomId,
            reportedBy: data.reportedBy || 'housekeeping',
            description: data.description || 'Issue reported from housekeeping',
          },
        });
        publisher.publish(
          'maintenance:work_order_created',
          JSON.stringify({ workOrderId: wo.id, roomId: wo.roomId })
        );
      }

      if (channel === 'room:maintenance' && data.type === 'MAINTENANCE_ISSUE') {
        // External maintenance flag — already handled by the publisher path, but ensure a WO exists.
        if (!data.workOrderId && data.roomId) {
          const wo = await prisma.workOrder.create({
            data: {
              workOrderNumber: nextWoNumber(),
              type: 'REACTIVE',
              priority: 'URGENT',
              roomId: data.roomId,
              description: data.description || 'Maintenance flagged',
            },
          });
          publisher.publish(
            'maintenance:work_order_created',
            JSON.stringify({ workOrderId: wo.id, roomId: wo.roomId })
          );
        }
      }
    } catch (err) {
      console.error('[Maintenance] Event handler error:', err.message);
    }
  });

  return subscriber;
}

module.exports = { startSubscriber };
