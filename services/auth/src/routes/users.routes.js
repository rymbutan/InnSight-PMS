const express = require('express');
const bcrypt = require('bcryptjs');
const Redis = require('ioredis');
const { verifyToken, requireRole, revocation } = require('../middleware/auth');

const router = express.Router();
const prisma = require('../lib/prisma');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Account data is read/write for both ADMIN and MANAGER — the one carve-out
// is that MANAGER can neither modify an account that already has the ADMIN
// role, nor grant ADMIN to any account (including a brand new one). Every
// route below is guarded with STAFF_ROLES and then, where a target account or
// a roles list is involved, an explicit check against the two helpers below.
const STAFF_ROLES = ['ADMIN', 'MANAGER'];

const { sanitizeUser: sanitize } = require('../lib/sanitizeUser');

function requesterIsAdmin(req) {
  return (req.user?.roles || []).includes('ADMIN');
}

// For routes that act on an EXISTING account. `targetRoles` is the target's
// CURRENT roles, freshly queried — never the requester's own token, and
// never assumed — so a stale cache can't let this be bypassed. Sends the
// 403 itself and returns true when it did, so a call site can just
// `if (await blockIfAdminTarget(...)) return;`.
async function blockIfAdminTarget(req, res, targetRoles) {
  if (requesterIsAdmin(req)) return false;
  if ((targetRoles || []).some((r) => r.roleCode === 'ADMIN')) {
    res.status(403).json({ error: 'Only an ADMIN can modify an admin account.' });
    return true;
  }
  return false;
}

// The bootstrap account is protected unconditionally — independent of, and
// checked before, the "last active admin" counting below. That guard only
// stops removing the LAST admin; it does nothing the moment a second admin
// exists, which is exactly when someone could delete or disable 'admin' and
// not notice until it mattered. Keyed on username rather than "is this
// account currently ADMIN", since a break-glass account has to survive even
// if its own role were ever stripped by mistake elsewhere.
function blockIfBootstrapAdmin(res, target, action) {
  if (target.username === 'admin') {
    res.status(400).json({ error: `The 'admin' account cannot be ${action}.` });
    return true;
  }
  return false;
}

// For routes that SET a roles list (creating a user, or replacing one's
// roles) — blocks a non-ADMIN from handing out the ADMIN role at all, not
// just from touching an account that already has it. Without this, a
// MANAGER who cannot edit an existing admin could still mint a fresh one.
function blockIfGrantingAdmin(req, res, roles) {
  if (requesterIsAdmin(req)) return false;
  if (Array.isArray(roles) && roles.includes('ADMIN')) {
    res.status(403).json({ error: 'Only an ADMIN can grant the ADMIN role.' });
    return true;
  }
  return false;
}

// The lockout guard: refuses to take ADMIN access away from an account when
// doing so would leave either that requester, or the whole system, unable to
// get back in. Shared by every route that can flip a user out of ACTIVE
// status, so the rule cannot drift between call sites the way it did before
// this existed — see the PUT /roles guard below for the sibling check that
// covers losing the ADMIN role rather than losing account access outright.
async function lockoutError(targetId, requesterId, targetRoles) {
  if (!targetRoles.some((r) => r.roleCode === 'ADMIN')) return null;
  if (targetId === requesterId) {
    return 'You cannot disable your own account. Ask another admin to do it.';
  }
  // ACTIVE only: another ADMIN who is themselves disabled is not a way back
  // in, so counting them would let the last usable admin be switched off.
  const otherActiveAdmins = await prisma.user.count({
    where: { id: { not: targetId }, status: 'ACTIVE', roles: { some: { roleCode: 'ADMIN' } } },
  });
  if (otherActiveAdmins === 0) {
    return 'This is the only active account with the ADMIN role. Disabling it would lock everyone out of user management. Create or enable another admin first.';
  }
  return null;
}

// GET /api/users
router.get('/users', verifyToken, requireRole(...STAFF_ROLES), async (req, res) => {
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
router.post('/users', verifyToken, requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const { username, email, password, displayName, roles } = req.body;
    if (!username || !password || !displayName) {
      return res.status(400).json({ error: 'username, password, displayName required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (blockIfGrantingAdmin(req, res, roles)) return;
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

// GET /api/users/housekeepers — the on-shift roster, and nothing else.
//
// Exists so the FRONT DESK can assign a room to a housekeeper and then ring that
// person. The desk does not hold `user.read` and must not: the alternative to
// this route was widening GET /api/users, which would hand the desk every
// account's email, status, roles and last-login to populate one dropdown.
//
// Narrow by construction rather than by discipline — it selects two columns for
// one role, so there is no filter here that a later edit could accidentally
// relax into a general user list.
//
// MUST be declared before /users/:id, or the param route swallows
// "housekeepers" as an id and answers 404.
const ROSTER_ROLES = ['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING_MAINTENANCE'];
router.get('/users/housekeepers', verifyToken, requireRole(...ROSTER_ROLES), async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: {
        status: 'ACTIVE', // a disabled account cannot answer a call
        roles: { some: { roleCode: 'HOUSEKEEPING_MAINTENANCE' } },
      },
      select: { id: true, displayName: true, username: true },
      orderBy: { displayName: 'asc' },
    });
    res.json(users);
  } catch (err) {
    console.error('[Auth] Housekeeper roster error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/users/directory — who you can message, and nothing else.
//
// The staff directory behind Messages. Unlike every other route in this file it
// carries NO requireRole, because messaging is not departmental: a housekeeper
// has to be able to look up the manager exactly as the manager looks up them.
// Restricting this by role would mean deciding which staff are allowed to be
// contacted, which is not a decision this feature makes.
//
// Widening GET /api/users was the alternative and is the wrong trade: that route
// returns whole account records — email, status, last login, avatar, every role
// — and opening it to all five roles to populate a contact list would hand out
// the account inventory to read four columns.
//
// Narrow by construction, like /users/housekeepers above: it selects the fields
// a contact row renders, for active accounts only, so there is no filter here a
// later edit could relax into a general user list.
//
// MUST be declared before /users/:id, or the param route swallows "directory".
router.get('/users/directory', verifyToken, async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { status: 'ACTIVE' }, // a disabled account cannot read its messages
      select: {
        id: true,
        username: true,
        displayName: true,
        roles: { select: { roleCode: true } },
      },
      orderBy: { displayName: 'asc' },
    });
    res.json(users.map((u) => ({ ...u, roles: u.roles.map((r) => r.roleCode) })));
  } catch (err) {
    console.error('[Auth] Directory error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/users/:id
router.get('/users/:id', verifyToken, requireRole(...STAFF_ROLES), async (req, res) => {
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
router.patch('/users/:id', verifyToken, requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const { displayName, email, status } = req.body;
    const data = {};
    if (displayName !== undefined) data.displayName = displayName;
    if (email !== undefined) data.email = email;
    if (status !== undefined) data.status = status;

    // Fetched unconditionally now, not just for a status change: a MANAGER
    // must not edit an admin's displayName/email either, and the lockout
    // check below still needs these same roles when status IS changing.
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { roles: true },
    });
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (await blockIfAdminTarget(req, res, target.roles)) return;

    // This route used to reach the same dead end as POST /disable — flipping
    // `status` here bypassed that route's lockout guard entirely, since this
    // one had none. Same rule, same helper.
    if (data.status !== undefined && data.status !== 'ACTIVE') {
      const err = await lockoutError(req.params.id, req.user?.sub, target.roles);
      if (err) return res.status(400).json({ error: err });
    }

    const user = await prisma.user.update({ where: { id: req.params.id }, data });
    res.json(sanitize(user));
  } catch (err) {
    console.error('[Auth] Update user error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/users/:id/reset-password
router.post('/users/:id/reset-password', verifyToken, requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'newPassword must be at least 8 characters.' });
    }
    const target = await prisma.user.findUnique({ where: { id: req.params.id }, include: { roles: true } });
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (await blockIfAdminTarget(req, res, target.roles)) return;
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
router.post('/users/:id/disable', verifyToken, requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    // The lockout guard. Disabling the last working ADMIN locks EVERYONE out of
    // user management permanently — including the person doing it — and the
    // only way back is a hand-written UPDATE against the database. A dialog in
    // the browser does not prevent this; it only asks. This does.
    //
    // Mirrors the same guard on PATCH /users/:id and PUT /users/:id/roles,
    // which stop the other two routes to the same dead end.
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { roles: true },
    });
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (blockIfBootstrapAdmin(res, target, 'disabled')) return;
    if (await blockIfAdminTarget(req, res, target.roles)) return;

    const err = await lockoutError(req.params.id, req.user?.sub, target.roles);
    if (err) return res.status(400).json({ error: err });

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

// DELETE /api/users/:id — remove an account permanently.
//
// ADMIN ONLY, deliberately narrower than every other route in this file
// (STAFF_ROLES = ADMIN + MANAGER). Disabling is reversible and is the right tool
// for someone who has left; deleting is not, so it is not a manager's to do.
//
// WHAT SURVIVES, AND WHY THAT IS THE POINT.
// Only UserRole is a real foreign key, and it is removed here in the same
// transaction. Everything else that names a user — TrainingResult.userId,
// AccessRequest.reviewedBy, and across services Reservation.createdBy,
// FolioTransaction.postedBy, Folio.auditApprovedBy — stores the id as a plain
// string in its own database. Those records are history: a folio that says who
// approved it must keep saying so after the account is gone, or deleting a user
// becomes a way to erase an audit trail. They keep the id; only the ability to
// resolve it back to a name is lost, and TrainingResult already denormalises
// userName for exactly that reason.
//
// Room.assignedTo is the one exception, because it is not history — it is a live
// statement about who is working a room right now, and a dangling assignment
// would let the desk ring a person who no longer exists. Cleared by inventory,
// which owns that column, off the event published below.
router.delete('/users/:id', verifyToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { roles: true },
    });
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (blockIfBootstrapAdmin(res, target, 'deleted')) return;

    // Deleting yourself signs you out of an account that no longer exists, with
    // no way back in. Checked before the admin count, so the message names the
    // actual problem rather than talking about admin coverage.
    if (target.id === req.user?.sub) {
      return res
        .status(400)
        .json({ error: 'You cannot delete your own account. Ask another admin to do it.' });
    }

    // The same last-admin guard the disable route carries, for the same reason:
    // removing the only usable administrator locks everyone out of user
    // management permanently, and deletion cannot be undone by re-enabling.
    if (target.roles.some((r) => r.roleCode === 'ADMIN')) {
      const otherActiveAdmins = await prisma.user.count({
        where: { id: { not: target.id }, status: 'ACTIVE', roles: { some: { roleCode: 'ADMIN' } } },
      });
      if (otherActiveAdmins === 0) {
        return res.status(400).json({
          error:
            'This is the only active account with the ADMIN role. Deleting it would lock everyone out of user management. Create another admin first.',
        });
      }
    }

    // One transaction: a half-deleted user whose roles are gone but whose row
    // remains is an account that can sign in and do nothing, which is worse than
    // either outcome on its own.
    await prisma.$transaction([
      prisma.userRole.deleteMany({ where: { userId: target.id } }),
      prisma.user.delete({ where: { id: target.id } }),
    ]);

    // A deleted user's tokens are still cryptographically valid until they
    // expire, and verifyToken checks the signature, not whether the row still
    // exists — so without this they would keep working for the token's full TTL.
    await revocation.revokeAllForUser(target.id);
    redis.publish('auth:user_deleted', JSON.stringify({ userId: target.id, username: target.username }));

    res.json({ id: target.id, username: target.username, deleted: true });
  } catch (err) {
    console.error('[Auth] Delete user error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/users/:id/enable
router.post('/users/:id/enable', verifyToken, requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id }, include: { roles: true } });
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (await blockIfAdminTarget(req, res, target.roles)) return;
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
router.put('/users/:id/roles', verifyToken, requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const { roles } = req.body;
    if (!Array.isArray(roles)) {
      return res.status(400).json({ error: 'roles must be an array of role codes.' });
    }
    const current = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { roles: true },
    });
    if (!current) return res.status(404).json({ error: 'User not found.' });
    const wasAdmin = current.roles.some((r) => r.roleCode === 'ADMIN');
    const staysAdmin = roles.includes('ADMIN');

    // Privilege-escalation guard: a MANAGER may manage any other account's
    // roles freely, but must neither grant the ADMIN role nor touch an
    // account that already has it. Checked against CURRENT rows, not the
    // requester's own token — irrelevant for the requester's identity, but
    // consistent with the lockout guard below, which has to be for the same
    // staleness reason.
    if (blockIfGrantingAdmin(req, res, roles)) return;
    if (await blockIfAdminTarget(req, res, current.roles)) return;

    // ── Do not let the ADMIN role leave the system ──────────────────────────
    // This is a REPLACE, so a save that simply omits 'ADMIN' strips it. Nothing
    // stopped the only administrator from doing exactly that to their own
    // account — and once no ADMIN exists the guard above makes it permanent,
    // because granting ADMIN requires an ADMIN. There is then no way back in
    // through the app at all, only a hand-written INSERT against the database.
    // This is not hypothetical; it is how the check came to be written.
    //
    // Tested against the CURRENT rows rather than the requester's token: token
    // roles can be up to 5 seconds stale (the epoch cache in
    // _shared/tokenRevocation.js), and this decision must not be.
    if (wasAdmin && !staysAdmin) {
      if (req.params.id === req.user?.sub) {
        return res.status(400).json({
          error:
            'You cannot remove your own ADMIN role. Ask another administrator, ' +
            'or grant ADMIN to a second account first.',
        });
      }
      const otherAdmins = await prisma.userRole.count({
        where: { roleCode: 'ADMIN', userId: { not: req.params.id } },
      });
      if (otherAdmins === 0) {
        return res.status(400).json({
          error:
            'This is the only account with the ADMIN role. Grant ADMIN to another ' +
            'account before removing it from this one.',
        });
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
router.get('/access-requests', verifyToken, requireRole(...STAFF_ROLES), async (req, res) => {
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
router.post('/access-requests/:id/approve', verifyToken, requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const reqRow = await prisma.accessRequest.findUnique({ where: { id: req.params.id } });
    if (!reqRow) return res.status(404).json({ error: 'Request not found.' });
    if (reqRow.status !== 'PENDING') {
      return res.status(409).json({ error: `Request already ${reqRow.status.toLowerCase()}.` });
    }

    const roles = Array.isArray(req.body?.roles) ? req.body.roles : [];
    if (blockIfGrantingAdmin(req, res, roles)) return;
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
    // Messaging keeps its own UserCache mirror and only learns about new
    // accounts from this event — without it, an approved user stays invisible
    // in chat until the messaging service happens to restart.
    redis.publish('auth:user_created', JSON.stringify({ userId: user.id, username }));

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
router.post('/access-requests/:id/reject', verifyToken, requireRole(...STAFF_ROLES), async (req, res) => {
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
