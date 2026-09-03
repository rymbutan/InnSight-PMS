const express = require('express');
const bcrypt = require('bcryptjs');
const Redis = require('ioredis');
const { verifyToken, requireRole, revocation } = require('../middleware/auth');

const router = express.Router();
const prisma = require('../lib/prisma');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const ADMIN_ROLES = ['ADMIN', 'MANAGER'];

const { sanitizeUser: sanitize } = require('../lib/sanitizeUser');

// GET /api/users
router.get('/users', verifyToken, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      include: { roles: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(users.map(sanitize));
  } catch (err) {
    console.error('[Auth] List users error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/users
router.post('/users', verifyToken, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const { username, email, password, displayName, roles } = req.body;
    if (!username || !password || !displayName) {
      return res.status(400).json({ error: 'username, password, displayName required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        username,
        email,
        passwordHash,
        displayName,
        mustChangePwd: true,
        roles: roles?.length ? { create: roles.map((r) => ({ roleCode: r })) } : undefined,
      },
      include: { roles: true },
    });
    redis.publish('auth:user_created', JSON.stringify({ userId: user.id, username }));
    res.status(201).json(sanitize(user));
  } catch (err) {
    console.error('[Auth] Create user error:', err.message);
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Username or email already in use.' });
    }
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/users/:id
router.get('/users/:id', verifyToken, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { roles: { include: { role: true } } },
    });
    if (!user) return res.status(404).json({ error: 'Not found.' });
    res.json(sanitize(user));
  } catch (err) {
    console.error('[Auth] Get user error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/users/:id
router.patch('/users/:id', verifyToken, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const { displayName, email, status } = req.body;
    const data = {};
    if (displayName !== undefined) data.displayName = displayName;
    if (email !== undefined) data.email = email;
    if (status !== undefined) data.status = status;
    const user = await prisma.user.update({ where: { id: req.params.id }, data });
    res.json(sanitize(user));
  } catch (err) {
    console.error('[Auth] Update user error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/users/:id/reset-password
router.post('/users/:id/reset-password', verifyToken, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'newPassword must be at least 8 characters.' });
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: req.params.id },
      data: { passwordHash, mustChangePwd: true, failedAttempts: 0, status: 'ACTIVE' },
    });
    // A reset means the old credential is gone; its sessions must go with it.
    await revocation.revokeAllForUser(req.params.id);
    redis.publish('auth:password_reset', JSON.stringify({ userId: req.params.id }));
    res.json({ success: true });
  } catch (err) {
    console.error('[Auth] Reset password error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/users/:id/disable
router.post('/users/:id/disable', verifyToken, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { status: 'DISABLED' },
    });
    // Disabling an account previously left its live tokens working for up to 12h.
    await revocation.revokeAllForUser(user.id);
    redis.publish('auth:user_disabled', JSON.stringify({ userId: user.id }));
    res.json(sanitize(user));
  } catch (err) {
    console.error('[Auth] Disable user error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/users/:id/enable
router.post('/users/:id/enable', verifyToken, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { status: 'ACTIVE', failedAttempts: 0 },
    });
    res.json(sanitize(user));
  } catch (err) {
    console.error('[Auth] Enable user error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/users/:id/roles
router.put('/users/:id/roles', verifyToken, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const { roles } = req.body;
    if (!Array.isArray(roles)) {
      return res.status(400).json({ error: 'roles must be an array of role codes.' });
    }
    // Privilege-escalation guard: a MANAGER may manage staff roles but must not
    // be able to grant the ADMIN role or take over an existing admin account.
    // Only an ADMIN can do either.
    const requesterIsAdmin = (req.user?.roles || []).includes('ADMIN');
    if (!requesterIsAdmin) {
      if (roles.includes('ADMIN')) {
        return res.status(403).json({ error: 'Only an ADMIN can grant the ADMIN role.' });
      }
      const target = await prisma.user.findUnique({ where: { id: req.params.id }, include: { roles: true } });
      if (target?.roles?.some((r) => r.roleCode === 'ADMIN')) {
        return res.status(403).json({ error: 'Only an ADMIN can modify an admin account.' });
      }
    }
    await prisma.userRole.deleteMany({ where: { userId: req.params.id } });
    if (roles.length) {
      await prisma.userRole.createMany({
        data: roles.map((roleCode) => ({ userId: req.params.id, roleCode })),
        skipDuplicates: true,
      });
    }
    const updated = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { roles: true },
    });
    // Roles are baked into the token, so without this a role change took up to 12h
    // to take effect — including a DEMOTION.
    await revocation.revokeAllForUser(req.params.id);
    redis.publish('auth:user_roles_changed', JSON.stringify({ userId: req.params.id, roles }));
    res.json(sanitize(updated));
  } catch (err) {
    console.error('[Auth] Set roles error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Access requests ─────────────────────────────────────────────────────────
// People who asked for an account from the sign-in screen. Approving one is what
// creates the User; until then the request grants nothing.

// GET /api/access-requests?status=PENDING
router.get('/access-requests', verifyToken, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const where = status === 'ALL' ? {} : { status };
    const rows = await prisma.accessRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json(rows);
  } catch (err) {
    console.error('[Auth] List access requests error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/access-requests/:id/approve — creates the User.
//
// The account is created WITHOUT a password: these people sign in with Google,
// and a random unguessable hash is stored so the password path can never be used
// against the account. Roles are whatever the admin ticks — the request itself
// never implies any.
router.post('/access-requests/:id/approve', verifyToken, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const reqRow = await prisma.accessRequest.findUnique({ where: { id: req.params.id } });
    if (!reqRow) return res.status(404).json({ error: 'Request not found.' });
    if (reqRow.status !== 'PENDING') {
      return res.status(409).json({ error: `Request already ${reqRow.status.toLowerCase()}.` });
    }

    const roles = Array.isArray(req.body?.roles) ? req.body.roles : [];
    const username = String(req.body?.username || reqRow.email.split('@')[0])
      .trim()
      .toLowerCase();

    const clash = await prisma.user.findFirst({
      where: { OR: [{ username }, { email: reqRow.email }] },
    });
    if (clash) return res.status(409).json({ error: 'That username or email already exists.' });

    // Not a placeholder anyone could guess: 64 random hex characters, hashed.
    const unusable = await bcrypt.hash(require('crypto').randomBytes(32).toString('hex'), 10);

    const user = await prisma.user.create({
      data: {
        username,
        email: reqRow.email,
        displayName: reqRow.fullName,
        passwordHash: unusable,
        status: 'ACTIVE',
        roles: { create: roles.map((roleCode) => ({ roleCode })) },
      },
      include: { roles: true },
    });

    await prisma.accessRequest.update({
      where: { id: reqRow.id },
      data: {
        status: 'APPROVED',
        reviewedAt: new Date(),
        reviewedBy: req.user?.username || null,
        createdUser: user.id,
      },
    });

    res.status(201).json(sanitize(user));
  } catch (err) {
    console.error('[Auth] Approve access request error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/access-requests/:id/reject
router.post('/access-requests/:id/reject', verifyToken, requireRole(...ADMIN_ROLES), async (req, res) => {
  try {
    const row = await prisma.accessRequest.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'Request not found.' });
    await prisma.accessRequest.update({
      where: { id: row.id },
      data: {
        status: 'REJECTED',
        reviewedAt: new Date(),
        reviewedBy: req.user?.username || null,
      },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Auth] Reject access request error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/roles
router.get('/roles', verifyToken, async (req, res) => {
  try {
    const roles = await prisma.role.findMany({
      include: { permissions: true },
      orderBy: { code: 'asc' },
    });
    res.json(roles);
  } catch (err) {
    console.error('[Auth] List roles error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/roles
router.post('/roles', verifyToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const { code, name, description, permissions } = req.body;
    const role = await prisma.role.create({
      data: {
        code,
        name,
        description,
        permissions: permissions?.length
          ? { create: permissions.map((p) => ({ permissionCode: p })) }
          : undefined,
      },
    });
    res.status(201).json(role);
  } catch (err) {
    console.error('[Auth] Create role error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/roles/:code/permissions
router.put('/roles/:code/permissions', verifyToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const { permissions } = req.body;
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ error: 'permissions must be an array of codes.' });
    }
    await prisma.rolePermission.deleteMany({ where: { roleCode: req.params.code } });
    if (permissions.length) {
      await prisma.rolePermission.createMany({
        data: permissions.map((permissionCode) => ({ roleCode: req.params.code, permissionCode })),
        skipDuplicates: true,
      });
    }
    const role = await prisma.role.findUnique({
      where: { code: req.params.code },
      include: { permissions: true },
    });
    res.json(role);
  } catch (err) {
    console.error('[Auth] Set role perms error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/permissions
router.get('/permissions', verifyToken, async (req, res) => {
  try {
    const perms = await prisma.permission.findMany({ orderBy: { code: 'asc' } });
    res.json(perms);
  } catch (err) {
    console.error('[Auth] List permissions error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
