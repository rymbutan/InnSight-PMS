const { PrismaClient } = require('@prisma/client');
const { DEMO_FROM, DEMO_TO, eachDay, dayKey, facilitySalesFor } = require('./lib/demoHistory');

// Two months of walk-in amenity sales, so Reports → Amenity Revenue has
// something to break down. Each one is written exactly the way the real POS
// writes it (POST /api/facility-sales in routes/folio.routes.js): a WALKIN
// folio, a CHARGE carrying the facility code and sourceSystem 'amenity-pos',
// a captured Payment, a PAYMENT transaction, folio closed. The report keys off
// sourceSystem, so anything shaped differently would simply not appear.
//
//   node src/seedDemoHistory.js            write the history
//   node src/seedDemoHistory.js --purge    take it back out
//
// Run through scripts/seed-demo-history.sh rather than directly.

const prisma = new PrismaClient();

// Demo folios are numbered distinctly so they can be found again and removed
// without touching a single real one. A purge matches on this prefix and
// nothing else.
const FOLIO_PREFIX = 'DEMO-AMN-';

// Deterministic, so re-running writes the same folio numbers and the
// already-exists check below actually matches.
const folioNumberFor = (key, i) =>
  `${FOLIO_PREFIX}${key.replace(/-/g, '')}-${String(i + 1).padStart(2, '0')}`;

const METHODS = ['CASH', 'CARD', 'GCASH'];

async function purge() {
  const folios = await prisma.folio.findMany({
    where: { folioNumber: { startsWith: FOLIO_PREFIX } },
    select: { id: true },
  });
  if (folios.length === 0) {
    console.log('[Folio] No demo amenity folios — nothing to purge.');
    return;
  }
  const ids = folios.map((f) => f.id);
  // Transactions cascade from the folio, payments do not.
  await prisma.payment.deleteMany({ where: { folioId: { in: ids } } });
  await prisma.folio.deleteMany({ where: { id: { in: ids } } });
  console.log(`[Folio] Purged ${folios.length} demo amenity folio(s).`);
}

async function write() {
  const existing = await prisma.folio.findMany({
    where: { folioNumber: { startsWith: FOLIO_PREFIX } },
    select: { folioNumber: true },
  });
  const have = new Set(existing.map((f) => f.folioNumber));

  let sales = 0;
  let skipped = 0;
  let totalCents = 0n;

  for (const day of eachDay(DEMO_FROM, DEMO_TO)) {
    const key = dayKey(day);
    const rows = facilitySalesFor(day);

    for (let i = 0; i < rows.length; i += 1) {
      const folioNumber = folioNumberFor(key, i);
      if (have.has(folioNumber)) {
        skipped += 1;
        continue;
      }
      const s = rows[i];
      const method = METHODS[(key.charCodeAt(9) + i) % METHODS.length];

      // One transaction per sale, in a transaction, exactly as the POS does it.
      await prisma.$transaction(async (px) => {
        const folio = await px.folio.create({
          data: {
            folioNumber,
            type: 'WALKIN',
            currency: 'PHP',
            status: 'CLOSED',
            openedAt: s.postedAt,
            closedAt: s.postedAt,
          },
        });
        await px.folioTransaction.create({
          data: {
            folioId: folio.id,
            type: 'CHARGE',
            chargeCode: s.code,
            description: `${s.name} (${s.unit})`,
            amountCents: BigInt(s.amountCents),
            quantity: s.units,
            postedAt: s.postedAt,
            postedBy: 'demo-history',
            // The one field Reports → Amenity Revenue filters on.
            sourceSystem: 'amenity-pos',
          },
        });
        const payment = await px.payment.create({
          data: {
            folioId: folio.id,
            method,
            amountCents: BigInt(s.amountCents),
            status: 'CAPTURED',
            createdAt: s.postedAt,
          },
        });
        await px.folioTransaction.create({
          data: {
            folioId: folio.id,
            type: 'PAYMENT',
            description: `Payment via ${method}`,
            amountCents: BigInt(s.amountCents),
            paymentMethod: method,
            reference: payment.id,
            postedAt: s.postedAt,
            postedBy: 'demo-history',
          },
        });
      });
      sales += 1;
      totalCents += BigInt(s.amountCents);
    }
  }

  console.log(
    `[Folio] Demo history: wrote ${sales} amenity sale(s) worth ` +
      `₱${(Number(totalCents) / 100).toLocaleString()} for ${DEMO_FROM}…${DEMO_TO}` +
      (skipped ? `, skipped ${skipped} that already existed.` : '.')
  );
}

const run = process.argv.includes('--purge') ? purge : write;

run()
  .catch((e) => {
    console.error('[Folio] Demo history error:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
