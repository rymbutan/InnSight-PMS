const Redis = require('ioredis');

const prisma = require('../lib/prisma');
const publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

function computeTier(lifetimeNights) {
  if (lifetimeNights >= 50) return 'PLATINUM';
  if (lifetimeNights >= 25) return 'GOLD';
  if (lifetimeNights >= 10) return 'SILVER';
  return 'BRONZE';
}

function startSubscriber() {
  const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  subscriber.subscribe('room:checkout', 'folio:closed', (err) => {
    if (err) {
      console.error('[Guest] Redis subscribe error:', err);
      return;
    }
    console.log('[Guest] Redis subscriber active — listening for guest events.');
  });

  subscriber.on('message', async (channel, message) => {
    try {
      const data = JSON.parse(message);

      if (channel === 'room:checkout' && data.guestId) {
        // Credit the nights actually stayed (from the checkout event), not a
        // flat 1 per checkout. Increment atomically to avoid lost updates.
        const nights = Number.isInteger(data.nights) && data.nights > 0 ? data.nights : 1;
        console.log(`[Guest] Crediting ${nights} lifetime night(s) for guest ${data.guestId}`);
        const loyalty = await prisma.loyaltyAccount.findUnique({ where: { guestId: data.guestId } });
        if (loyalty) {
          const updated = await prisma.loyaltyAccount.update({
            where: { guestId: data.guestId },
            data: { lifetimeNights: { increment: nights } },
          });
          const newTier = computeTier(updated.lifetimeNights);
          if (newTier !== loyalty.tier) {
            await prisma.loyaltyAccount.update({ where: { guestId: data.guestId }, data: { tier: newTier } });
            publisher.publish(
              'loyalty:tier_changed',
              JSON.stringify({
                guestId: data.guestId,
                oldTier: loyalty.tier,
                newTier,
              })
            );
          }
        }
      }

      if (channel === 'folio:closed' && data.guestId) {
        console.log(`[Guest] Accruing loyalty for guest ${data.guestId}`);
        const loyalty = await prisma.loyaltyAccount.findUnique({ where: { guestId: data.guestId } });
        if (loyalty) {
          const spend = data.totalCents ? Math.floor(Number(data.totalCents) / 100) : 0;
          const earnedPoints = Math.floor(spend / 10);
          await prisma.loyaltyAccount.update({
            where: { guestId: data.guestId },
            data: {
              lifetimeSpend: loyalty.lifetimeSpend + spend,
              pointsBalance: loyalty.pointsBalance + earnedPoints,
              lifetimePoints: loyalty.lifetimePoints + earnedPoints,
            },
          });
        }
      }
    } catch (err) {
      console.error('[Guest] Event handler error:', err.message);
    }
  });

  return subscriber;
}

module.exports = { startSubscriber };
