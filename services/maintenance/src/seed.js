const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const ASSETS = [
  {
    tag: 'AST-AC-001',
    name: 'Lobby AC Unit',
    category: 'HVAC',
    location: 'Lobby',
    manufacturer: 'Carrier',
    model: '40MAQ',
    status: 'OPERATIONAL',
  },
  {
    tag: 'AST-ELV-001',
    name: 'Main Elevator',
    category: 'VERTICAL_TRANSPORT',
    location: 'Core',
    manufacturer: 'Mitsubishi',
    model: 'NEXIEZ',
    status: 'OPERATIONAL',
  },
  {
    tag: 'AST-PMP-001',
    name: 'Water Pump',
    category: 'PLUMBING',
    location: 'Basement',
    manufacturer: 'Grundfos',
    model: 'CR10',
    status: 'OPERATIONAL',
  },
];

const PARTS = [
  { sku: 'P-FLT-A12', name: 'HVAC Air Filter A12', onHand: 8, minStock: 4, unitCostCents: BigInt(45000) },
  { sku: 'P-BLB-LED9', name: 'LED Bulb 9W', onHand: 24, minStock: 10, unitCostCents: BigInt(15000) },
  { sku: 'P-VLV-0.5', name: 'Water Valve 1/2"', onHand: 2, minStock: 5, unitCostCents: BigInt(35000) },
  { sku: 'P-TWL-STD', name: 'Standard Bath Towel', onHand: 120, minStock: 50, unitCostCents: BigInt(25000) },
  { sku: 'P-LCK-CRD', name: 'RFID Keycard Blank', onHand: 200, minStock: 100, unitCostCents: BigInt(5000) },
];

async function seed() {
  console.log('[Maintenance] Seeding assets and parts...');

  const existingAssets = await prisma.asset.count();
  if (existingAssets === 0) {
    for (const a of ASSETS) {
      await prisma.asset.create({ data: a });
    }
  }

  const existingParts = await prisma.part.count();
  if (existingParts === 0) {
    for (const p of PARTS) {
      await prisma.part.create({ data: p });
    }
  }

  if (existingAssets > 0 && existingParts > 0) {
    console.log('[Maintenance] Already seeded. Skipping.');
    return;
  }

  console.log(`[Maintenance] Seeded ${ASSETS.length} assets, ${PARTS.length} parts.`);
}

seed()
  .catch((e) => {
    console.error('[Maintenance] Seed error:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
