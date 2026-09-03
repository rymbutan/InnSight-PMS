const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const PERMISSIONS = [
  // Inventory / rooms
  'room.read',
  'room.write',
  'room.status.update',
  'rateplan.read',
  'rateplan.write',
  // Reservations / stay
  'reservation.read',
  'reservation.write',
  'stay.checkin',
  'stay.checkout',
  'stay.walkin',
  'stay.early_departure',
  // Folio
  'folio.read',
  'folio.charge',
  'folio.payment',
  'folio.adjust',
  'folio.void',
  'folio.close',
  'folio.print',
  'chargecode.read',
  'chargecode.write',
  // Guest
  'guest.read',
  'guest.write',
  'guest.anonymize',
  'guest.flag',
  // Housekeeping
  'hk.read',
  'hk.update',
  // Maintenance
  'maintenance.read',
  'maintenance.write',
  // Night audit / reports
  'audit.run',
  'report.read',
  // User admin
  'user.read',
  'user.write',
  'role.write',
];

const ROLES = [
  {
    code: 'ADMIN',
    name: 'Administrator',
    description: 'Full system access',
    permissions: PERMISSIONS,
  },
  {
    code: 'MANAGER',
    name: 'Manager',
    description: 'Front-office manager, reports and overrides',
    permissions: PERMISSIONS.filter((p) => !['role.write'].includes(p)),
  },
  {
    code: 'FRONT_DESK',
    name: 'Front Desk Agent',
    description: 'Check-in/out, folio, guest profiles',
    permissions: [
      'room.read',
      'rateplan.read',
      'chargecode.read',
      'reservation.read',
      'reservation.write',
      'stay.checkin',
      'stay.checkout',
      'stay.walkin',
      'folio.read',
      'folio.charge',
      'folio.payment',
      'folio.print',
      'guest.read',
      'guest.write',
      'hk.read',
    ],
  },
  {
    code: 'HOUSEKEEPING',
    name: 'Housekeeping',
    description: 'Room status and housekeeping tasks',
    permissions: ['room.read', 'hk.read', 'hk.update'],
  },
  {
    code: 'MAINTENANCE',
    name: 'Maintenance',
    description: 'Work orders and assets',
    permissions: ['room.read', 'maintenance.read', 'maintenance.write'],
  },
  {
    code: 'AUDITOR',
    name: 'Night Auditor',
    description: 'Runs night audit and reviews folios',
    permissions: ['folio.read', 'audit.run', 'report.read', 'room.read'],
  },
];

// Passwords this repo has published in source control (seed.js, seed-demo.sh,
// docs). They are public and must be refused outright.
const WEAK_ADMIN_PASSWORDS = new Set(['admin12345', 'admin', 'password', 'innsight_dev_2025', 'change_me']);

async function seed() {
  console.log('[Auth] Seeding permissions, roles, and default admin...');

  for (const code of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code },
    });
  }

  for (const r of ROLES) {
    await prisma.role.upsert({
      where: { code: r.code },
      update: { name: r.name, description: r.description },
      create: { code: r.code, name: r.name, description: r.description },
    });
    await prisma.rolePermission.deleteMany({ where: { roleCode: r.code } });
    await prisma.rolePermission.createMany({
      data: r.permissions.map((permissionCode) => ({ roleCode: r.code, permissionCode })),
      skipDuplicates: true,
    });
  }

  // One-time migration: the front-desk role was renamed FRONT_OFFICE → FRONT_DESK
  // to match the rest of the system (frontend routes, gateway, reservation
  // service). Move any users still on the old code over, then drop the orphan.
  const legacy = await prisma.role.findUnique({ where: { code: 'FRONT_OFFICE' } });
  if (legacy) {
    const legacyUsers = await prisma.userRole.findMany({ where: { roleCode: 'FRONT_OFFICE' } });
    for (const ur of legacyUsers) {
      await prisma.userRole.upsert({
        where: { userId_roleCode: { userId: ur.userId, roleCode: 'FRONT_DESK' } },
        update: {},
        create: { userId: ur.userId, roleCode: 'FRONT_DESK' },
      });
    }
    await prisma.userRole.deleteMany({ where: { roleCode: 'FRONT_OFFICE' } });
    await prisma.rolePermission.deleteMany({ where: { roleCode: 'FRONT_OFFICE' } });
    await prisma.role.delete({ where: { code: 'FRONT_OFFICE' } });
    console.log(
      `[Auth] Migrated ${legacyUsers.length} user(s) FRONT_OFFICE → FRONT_DESK and removed the legacy role.`
    );
  }

  const existing = await prisma.user.findUnique({ where: { username: 'admin' } });
  if (!existing) {
    // The initial admin password comes from the environment and is NEVER
    // hardcoded and NEVER logged. Previously this was `bcrypt.hash('admin12345')`
    // followed by a console.log of the plaintext — on a seed that re-ran on every
    // single container start, so the live credentials sat in `docker logs` for the
    // lifetime of the deployment.
    const password = process.env.ADMIN_INITIAL_PASSWORD;
    if (!password) {
      throw new Error(
        'ADMIN_INITIAL_PASSWORD is not set, so the admin account cannot be created.\n' +
          '  Set it in your .env (compose passes it through), e.g.\n' +
          '    ADMIN_INITIAL_PASSWORD=$(openssl rand -base64 24)\n' +
          '  It is used once, at first seed, and the account is flagged mustChangePwd.'
      );
    }
    if (password.length < 12) {
      throw new Error(`ADMIN_INITIAL_PASSWORD is only ${password.length} characters; use at least 12.`);
    }
    if (WEAK_ADMIN_PASSWORDS.has(password.toLowerCase())) {
      throw new Error('ADMIN_INITIAL_PASSWORD is a known-published value from this repo. Choose a new one.');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const admin = await prisma.user.create({
      data: {
        username: 'admin',
        email: 'admin@innsight.local',
        passwordHash,
        displayName: 'System Administrator',
        // Forces the /change-password flow on first login, so the value from the
        // environment is only ever valid for that one sign-in.
        mustChangePwd: true,
        roles: { create: [{ roleCode: 'ADMIN' }] },
      },
    });
    console.log(
      `[Auth] Created admin account id=${admin.id} from ADMIN_INITIAL_PASSWORD (must change on first login).`
    );
  } else {
    console.log('[Auth] Default admin already exists. Skipping.');
  }

  console.log(`[Auth] Seed complete: ${PERMISSIONS.length} permissions, ${ROLES.length} roles.`);
}

seed()
  .catch((e) => {
    console.error('[Auth] Seed error:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
