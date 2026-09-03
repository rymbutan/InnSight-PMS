const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function seed() {
  const count = await prisma.businessDay.count();
  if (count > 0) {
    console.log('[Audit] Already seeded.');
    return;
  }
  console.log('[Audit] No seed data required.');
}

seed()
  .catch((e) => {
    console.error('[Audit] Seed error:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
