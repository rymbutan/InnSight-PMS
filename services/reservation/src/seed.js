const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function seed() {
  const existing = await prisma.reservation.count();
  if (existing > 0) {
    console.log('[Reservation] Already seeded. Skipping.');
    return;
  }
  console.log('[Reservation] No sample data seeded (awaiting room types).');
}

seed()
  .catch((e) => {
    console.error('[Reservation] Seed error:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
