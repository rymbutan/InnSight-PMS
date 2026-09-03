const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function seed() {
  console.log('[Stay] Seeding sample stays...');

  const existing = await prisma.stay.count();
  if (existing > 0) {
    console.log('[Stay] Already seeded. Skipping.');
    return;
  }

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(today);
  dayAfter.setDate(dayAfter.getDate() + 2);

  await prisma.stay.create({
    data: {
      reservationId: 'RES-SEED-001',
      guestName: 'Juan Dela Cruz',
      expectedCheckIn: today,
      expectedCheckOut: tomorrow,
      status: 'PRE_ARRIVAL',
    },
  });

  await prisma.stay.create({
    data: {
      reservationId: 'RES-SEED-002',
      guestName: 'Maria Santos',
      expectedCheckIn: tomorrow,
      expectedCheckOut: dayAfter,
      status: 'PRE_ARRIVAL',
    },
  });

  console.log('[Stay] Seeded 2 sample stays.');
}

seed()
  .catch((e) => {
    console.error('[Stay] Seed error:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
