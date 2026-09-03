const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// baseRate is stored in centavos (the web app's money helpers convert to
// pesos for display): ₱2,800.00 → 280000.
//
// `perFloor` is the mix on EACH floor, not the total. One floor of 15 rooms was
// too small a property to exercise the system against: with a handful of rooms
// and one booking there is no queue to work through, no second room of the same
// type to compare, and the housekeeping map draws a single stub row.
const FLOORS = 3;
const ROOM_TYPES = [
  { code: 'STD', name: 'Standard', baseRate: 280000, maxOccupancy: 2, perFloor: 8 },
  { code: 'DLX', name: 'Deluxe', baseRate: 420000, maxOccupancy: 3, perFloor: 4 },
  { code: 'STE', name: 'Suite', baseRate: 750000, maxOccupancy: 4, perFloor: 2 },
  { code: 'PRS', name: 'Presidential', baseRate: 1500000, maxOccupancy: 4, perFloor: 1 },
];

// A room's number is floor × 100 + its index on that floor — 101…115, 201…215.
// The housekeeping map sorts on this to split rooms into its two rows, and a
// flat 101…145 run would put every room on "floor 1" as far as
// `Math.floor(number / 100)` is concerned.
function roomsFor(floor) {
  const out = [];
  let idx = 0;
  for (const rt of ROOM_TYPES) {
    for (let i = 0; i < rt.perFloor; i += 1) {
      idx += 1;
      out.push({ number: String(floor * 100 + idx), typeCode: rt.code, floor });
    }
  }
  return out;
}

async function seed() {
  console.log('[Inventory] Seeding rooms and room types...');

  const existing = await prisma.roomType.count();
  if (existing > 0) {
    console.log('[Inventory] Already seeded. Skipping.');
    return;
  }

  for (const rt of ROOM_TYPES) {
    await prisma.roomType.create({
      data: {
        code: rt.code,
        name: rt.name,
        baseRate: rt.baseRate,
        maxOccupancy: rt.maxOccupancy,
        // Must equal the number of rooms that actually exist: availability is
        // totalInventory minus held nights, so a count set below the real one
        // refuses bookings for rooms standing empty — which looks exactly like a
        // bug in the booking engine rather than a seeding mistake.
        totalInventory: rt.perFloor * FLOORS,
      },
    });
  }

  const rooms = [];
  for (let floor = 1; floor <= FLOORS; floor += 1) rooms.push(...roomsFor(floor));
  for (const r of rooms) {
    await prisma.room.create({
      data: {
        id: r.number,
        number: r.number,
        typeCode: r.typeCode,
        floor: r.floor,
        status: 'CLEAN',
        features: { tv: true, wifi: true },
      },
    });
  }

  // Default rate plans
  const now = new Date();
  const yearOut = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
  for (const rt of ROOM_TYPES) {
    await prisma.ratePlan.create({
      data: {
        roomTypeCode: rt.code,
        name: `${rt.name} BAR`,
        baseRate: rt.baseRate,
        validFrom: now,
        validTo: yearOut,
      },
    });
  }

  console.log(
    `[Inventory] Seeded ${rooms.length} rooms across ${FLOORS} floor(s), ${ROOM_TYPES.length} room types.`
  );
}

// Amenities/facilities (prices in centavos). Upserted by code so re-seeding never
// overwrites an admin's later price edits (update:{} on conflict).
const FACILITIES = [
  {
    code: 'HALL',
    name: 'Grand Function Hall',
    category: 'EVENT_HALL',
    pricingModel: 'PER_HOUR',
    priceCents: 150000,
    unit: 'per hour',
    capacity: 120,
    reservable: true,
    description: 'Events, weddings, conferences.',
  },
  {
    code: 'MTG',
    name: 'Meeting Room',
    category: 'MEETING_ROOM',
    pricingModel: 'PER_HOUR',
    priceCents: 50000,
    unit: 'per hour',
    capacity: 20,
    reservable: true,
    description: 'Boardroom with AV.',
  },
  {
    code: 'GYM',
    name: 'Fitness Center',
    category: 'GYM',
    pricingModel: 'PER_USE',
    priceCents: 20000,
    unit: 'day pass',
    capacity: 30,
    reservable: false,
    description: 'Gym day pass.',
  },
  {
    code: 'POOL',
    name: 'Swimming Pool',
    category: 'POOL',
    pricingModel: 'PER_USE',
    priceCents: 25000,
    unit: 'day pass',
    capacity: 50,
    reservable: false,
    description: 'Pool day pass.',
  },
  {
    code: 'RESTO',
    name: 'Restaurant / Café',
    category: 'RESTAURANT',
    pricingModel: 'PER_PERSON',
    priceCents: 60000,
    unit: 'per person',
    capacity: 80,
    reservable: false,
    description: 'Buffet / à la carte.',
  },
  {
    code: 'SPA',
    name: 'Spa & Massage',
    category: 'SPA',
    pricingModel: 'PER_USE',
    priceCents: 120000,
    unit: 'per session',
    capacity: 8,
    reservable: false,
    description: 'Massage & wellness.',
  },
  {
    code: 'PARK',
    name: 'Parking',
    category: 'PARKING',
    pricingModel: 'PER_DAY',
    priceCents: 15000,
    unit: 'per day',
    capacity: 100,
    reservable: false,
    description: 'Day parking for walk-ins.',
  },
  {
    code: 'LAUNDRY',
    name: 'Laundry Service',
    category: 'LAUNDRY',
    pricingModel: 'PER_USE',
    priceCents: 30000,
    unit: 'per load',
    capacity: null,
    reservable: false,
    // Superseded by the per-piece LDY_* catalogue below (Changes-to-be-made doc,
    // item 2). Kept, inactive, so historical folio lines coded 'LAUNDRY' keep a
    // label — and seeded inactive so a from-scratch install matches an upgraded
    // one, where the migration deactivates it.
    active: false,
    description: 'Superseded by per-piece laundry pricing.',
  },
  // ── Per-piece laundry catalogue ───────────────────────────────────────────
  // Polo and long-sleeve prices come from the change request; the rest are
  // placeholders, editable from the amenities admin UI.
  {
    code: 'LDY_POLO',
    name: 'Laundry — Polo',
    category: 'LAUNDRY',
    pricingModel: 'PER_USE',
    priceCents: 20000,
    unit: 'per piece',
    capacity: null,
    reservable: false,
    description: 'Wash, dry and press, per polo shirt.',
  },
  {
    code: 'LDY_LONGSLEEVE',
    name: 'Laundry — Long-sleeve shirt',
    category: 'LAUNDRY',
    pricingModel: 'PER_USE',
    priceCents: 15000,
    unit: 'per piece',
    capacity: null,
    reservable: false,
    description: 'Wash, dry and press, per long-sleeve shirt.',
  },
  {
    code: 'LDY_TROUSERS',
    name: 'Laundry — Trousers',
    category: 'LAUNDRY',
    pricingModel: 'PER_USE',
    priceCents: 18000,
    unit: 'per piece',
    capacity: null,
    reservable: false,
    description: 'Wash, dry and press, per pair of trousers.',
  },
  {
    code: 'LDY_DRESS',
    name: 'Laundry — Dress',
    category: 'LAUNDRY',
    pricingModel: 'PER_USE',
    priceCents: 25000,
    unit: 'per piece',
    capacity: null,
    reservable: false,
    description: 'Dry clean and press, per dress.',
  },
  {
    code: 'LDY_BEDSHEET',
    name: 'Laundry — Bed sheet',
    category: 'LAUNDRY',
    pricingModel: 'PER_USE',
    priceCents: 22000,
    unit: 'per piece',
    capacity: null,
    reservable: false,
    description: 'Wash and press, per bed sheet.',
  },
  // ── Individually priced services ──────────────────────────────────────────
  {
    code: 'VALET',
    name: 'Valet Parking',
    category: 'PARKING',
    pricingModel: 'PER_DAY',
    priceCents: 15000,
    unit: 'per day',
    capacity: null,
    reservable: false,
    description: 'Attended valet parking, per calendar day.',
  },
  {
    code: 'MASSAGE_60',
    name: 'Massage — 60 minutes',
    category: 'SPA',
    pricingModel: 'PER_USE',
    priceCents: 120000,
    unit: 'per session',
    capacity: null,
    reservable: false,
    description: 'Sixty-minute full-body massage with a licensed therapist.',
  },
  {
    code: 'MASSAGE_90',
    name: 'Massage — 90 minutes',
    category: 'SPA',
    pricingModel: 'PER_USE',
    priceCents: 170000,
    unit: 'per session',
    capacity: null,
    reservable: false,
    description: 'Ninety-minute full-body massage with a licensed therapist.',
  },
  // ── Subdivisions of the grand function hall ───────────────────────────────
  // Listed last so their parent already exists when the FK is checked.
  {
    code: 'HALL_A',
    name: 'Function Hall — Section A',
    category: 'EVENT_HALL',
    pricingModel: 'PER_HOUR',
    priceCents: 60000,
    unit: 'per hour',
    capacity: 40,
    reservable: true,
    description: 'One third of the Grand Function Hall, divided by air wall.',
    parentCode: 'HALL',
  },
  {
    code: 'HALL_B',
    name: 'Function Hall — Section B',
    category: 'EVENT_HALL',
    pricingModel: 'PER_HOUR',
    priceCents: 60000,
    unit: 'per hour',
    capacity: 40,
    reservable: true,
    description: 'One third of the Grand Function Hall, divided by air wall.',
    parentCode: 'HALL',
  },
  {
    code: 'HALL_C',
    name: 'Function Hall — Section C',
    category: 'EVENT_HALL',
    pricingModel: 'PER_HOUR',
    priceCents: 60000,
    unit: 'per hour',
    capacity: 40,
    reservable: true,
    description: 'One third of the Grand Function Hall, divided by air wall.',
    parentCode: 'HALL',
  },
];

async function seedFacilities() {
  for (const f of FACILITIES) {
    await prisma.facility.upsert({ where: { code: f.code }, create: f, update: {} });
  }
  console.log(`[Inventory] Ensured ${FACILITIES.length} facilities/amenities.`);
}

seed()
  .then(seedFacilities)
  .catch((e) => {
    console.error('[Inventory] Seed error:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
