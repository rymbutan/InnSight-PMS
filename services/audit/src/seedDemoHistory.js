const { PrismaClient } = require('@prisma/client');
const { DEMO_FROM, DEMO_TO, eachDay, dayKey, businessDayFor } = require('./lib/demoHistory');

// Two months of closed business days, so Reports → Occupancy / Revenue and the
// Revenue page have something to read. See lib/demoHistory.js for what the
// numbers are and why this is not part of the normal seed.
//
//   node src/seedDemoHistory.js            write the history
//   node src/seedDemoHistory.js --purge    take it back out
//
// Run through scripts/seed-demo-history.sh rather than directly.

const prisma = new PrismaClient();

// The audit's own steps are recorded per day; a purge has to take those with it
// or the next write trips the businessDate unique constraint on an orphan.
async function purge() {
  // Local midnight, matching how the rows are written and how
  // GET /api/audit/days queries them.
  const from = new Date(`${DEMO_FROM}T00:00:00`);
  const to = new Date(`${DEMO_TO}T23:59:59`);
  const days = await prisma.businessDay.findMany({
    where: { businessDate: { gte: from, lte: to } },
    select: { id: true },
  });
  if (days.length === 0) {
    console.log('[Audit] No demo history in the window — nothing to purge.');
    return;
  }
  const ids = days.map((d) => d.id);
  await prisma.auditStep.deleteMany({ where: { businessDayId: { in: ids } } });
  await prisma.businessDay.deleteMany({ where: { id: { in: ids } } });
  console.log(`[Audit] Purged ${days.length} business day(s) between ${DEMO_FROM} and ${DEMO_TO}.`);
}

async function write() {
  const days = eachDay(DEMO_FROM, DEMO_TO);

  // Never overwrite a day that genuinely closed. If the night audit has already
  // run for a date in this window, that is real trading and this script has no
  // business replacing it with invented figures.
  const existing = await prisma.businessDay.findMany({
    where: {
      businessDate: {
        gte: new Date(`${DEMO_FROM}T00:00:00`),
        lte: new Date(`${DEMO_TO}T23:59:59`),
      },
    },
    select: { businessDate: true },
  });
  const have = new Set(existing.map((d) => dayKey(d.businessDate)));

  let written = 0;
  for (const day of days) {
    if (have.has(dayKey(day))) continue;
    const row = businessDayFor(day);
    await prisma.businessDay.create({
      data: {
        ...row,
        roomRevenueCents: BigInt(row.roomRevenueCents),
        facilityRevenueCents: BigInt(row.facilityRevenueCents),
        otherRevenueCents: BigInt(row.otherRevenueCents),
        taxCents: BigInt(row.taxCents),
        paymentsCents: BigInt(row.paymentsCents),
        // A closed day needs an audited-at time; use the end of the day it
        // covers rather than "now", so the record reads like history.
        openedAt: new Date(row.businessDate.getTime() + 6 * 3600000),
        closedAt: new Date(row.businessDate.getTime() + 23 * 3600000),
        closedBy: 'demo-history',
        notes: 'Generated demo history — see services/_shared/demoHistory.js',
      },
    });
    written += 1;
  }

  const skipped = days.length - written;
  console.log(
    `[Audit] Demo history: wrote ${written} business day(s) for ${DEMO_FROM}…${DEMO_TO}` +
      (skipped ? `, skipped ${skipped} that already existed.` : '.')
  );
}

const run = process.argv.includes('--purge') ? purge : write;

run()
  .catch((e) => {
    console.error('[Audit] Demo history error:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
