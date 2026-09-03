const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function seed() {
  console.log('[Reports] No seed data required.');
}

seed()
  .catch((e) => {
    console.error('[Reports] Seed error:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
