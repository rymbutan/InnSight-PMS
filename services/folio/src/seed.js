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
  // FACILITY is its own category so the night audit can report walk-in facility
  // income apart from a resident guest's extras — a non-guest paying for the pool
  // is not the same line of business as a minibar charge. classifyTransactions and
  // the daily-totals route both key off the category, never the code.
  { code: 'POOL', name: 'Swimming Pool', category: 'FACILITY', glAccount: '4310', taxable: true },
  { code: 'HALL', name: 'Function Hall', category: 'FACILITY', glAccount: '4320', taxable: true },
  { code: 'GYM', name: 'Gym', category: 'FACILITY', glAccount: '4330', taxable: true },
];

async function seed() {
  console.log('[Folio] Seeding charge codes...');

  // Upsert rather than skip-if-any-exist: the old guard meant a new charge code
  // never reached a database that had already been seeded, which is exactly how
  // the FACILITY codes below would have silently failed to appear.
  for (const cc of CHARGE_CODES) {
    await prisma.chargeCode.upsert({ where: { code: cc.code }, update: cc, create: cc });
  }

  console.log(`[Folio] Seeded ${CHARGE_CODES.length} charge codes.`);
}

seed()
  .catch((e) => {
    console.error('[Folio] Seed error:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
