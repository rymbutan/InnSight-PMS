const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const CHARGE_CODES = [
  { code: 'RM', name: 'Room', category: 'ROOM', glAccount: '4000', taxable: true },
  { code: 'FB', name: 'Food & Beverage', category: 'FNB', glAccount: '4100', taxable: true },
  { code: 'MB', name: 'Minibar', category: 'FNB', glAccount: '4110', taxable: true },
  { code: 'LD', name: 'Laundry', category: 'SERVICE', glAccount: '4200', taxable: true },
  { code: 'PK', name: 'Parking', category: 'SERVICE', glAccount: '4210', taxable: true },
  { code: 'DM', name: 'Damage', category: 'MISC', glAccount: '4900', taxable: false },
  { code: 'AO', name: 'Add-on / Special Request', category: 'SERVICE', glAccount: '4220', taxable: true },
];

async function seed() {
  console.log('[Folio] Seeding charge codes...');

  const existing = await prisma.chargeCode.count();
  if (existing > 0) {
    console.log('[Folio] Already seeded. Skipping.');
    return;
  }

  for (const cc of CHARGE_CODES) {
    await prisma.chargeCode.create({ data: cc });
  }

  console.log(`[Folio] Seeded ${CHARGE_CODES.length} charge codes.`);
}

seed()
  .catch((e) => {
    console.error('[Folio] Seed error:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
