const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const SAMPLES = [
  {
    profileNumber: 'G-SEED-0001',
    firstName: 'Isabella',
    lastName: 'Reyes',
    displayName: 'Isabella Reyes',
    nationality: 'PH',
    vipLevel: 'GOLD',
    loyalty: {
      membershipNumber: 'IS-GOLD-001',
      tier: 'GOLD',
      pointsBalance: 12500,
      lifetimePoints: 80000,
      lifetimeNights: 28,
    },
  },
  {
    profileNumber: 'G-SEED-0002',
    firstName: 'Carlos',
    lastName: 'Mendoza',
    displayName: 'Carlos Mendoza',
    nationality: 'PH',
    vipLevel: 'SILVER',
    loyalty: {
      membershipNumber: 'IS-SILV-002',
      tier: 'SILVER',
      pointsBalance: 3200,
      lifetimePoints: 15000,
      lifetimeNights: 12,
    },
  },
  {
    profileNumber: 'G-SEED-0003',
    firstName: 'Anna',
    lastName: 'Garcia',
    displayName: 'Anna Garcia',
    nationality: 'PH',
    vipLevel: 'NONE',
    loyalty: null,
  },
];

async function seed() {
  console.log('[Guest] Seeding sample guests...');

  const existing = await prisma.guest.count();
  if (existing > 0) {
    console.log('[Guest] Already seeded. Skipping.');
    return;
  }

  for (const g of SAMPLES) {
    const guest = await prisma.guest.create({
      data: {
        profileNumber: g.profileNumber,
        firstName: g.firstName,
        lastName: g.lastName,
        displayName: g.displayName,
        nationality: g.nationality,
        vipLevel: g.vipLevel,
      },
    });
    if (g.loyalty) {
      await prisma.loyaltyAccount.create({
        data: {
          guestId: guest.id,
          ...g.loyalty,
        },
      });
    }
  }

  console.log(`[Guest] Seeded ${SAMPLES.length} guests.`);
}

seed()
  .catch((e) => {
    console.error('[Guest] Seed error:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
