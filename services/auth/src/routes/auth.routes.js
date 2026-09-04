const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const { verifyToken, JWT_SECRET, revocation, ALG, ISS_HUMAN, AUD } = require('../middleware/auth');
const { verifyGoogleIdToken, verifyGoogleAccessToken } = require('../lib/googleIdToken');

const router = express.Router();
const prisma = require('../lib/prisma');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const TOKEN_TTL = process.env.JWT_TTL || '12h';
const MAX_FAILED = 5;

// University sign-in. GOOGLE_CLIENT_ID is the OAuth client id from Google Cloud
// Console; when it is unset the endpoint below refuses every request and the web
// app hides the button, so the feature is simply off rather than half-wired.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const ALLOWED_EMAIL_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || 'slsu.edu.ph';

async function loadUserContext(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: {
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      },
    },
  });
  if (!user) return null;
  const roles = user.roles.map((ur) => ur.roleCode);
  const permissions = [
    ...new Set(user.roles.flatMap((ur) => ur.role.permissions.map((rp) => rp.permissionCode))),
  ];
  return { user, roles, permissions };
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required.' });
    }
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      const failed = user.failedAttempts + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedAttempts: failed,
          status: failed >= MAX_FAILED ? 'LOCKED' : user.status,
        },
      });
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    // Only reveal that an account is non-usable AFTER a correct password, so a
    // wrong-password attacker can't probe account existence or status.
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ error: `Account ${user.status.toLowerCase()}.` });
    }

    const ctx = await loadUserContext(user.id);
    const token = jwt.sign(
      {
        sub: user.id,
        username: user.username,
        displayName: user.displayName,
        roles: ctx.roles,
        permissions: ctx.permissions,
        // Unique per session so logout can revoke THIS token specifically rather
        // than every session the user has open.
        jti: crypto.randomUUID(),
        // Issued-at in MILLISECONDS, alongside the standard whole-second `iat`.
        // The per-user revocation epoch is compared against this; at second
        // precision a token minted in the same second as a role or password
        // change tied with the epoch and was rejected on arrival. See the note
        // in _shared/tokenRevocation.js.
        iatMs: Date.now(),
      },
      JWT_SECRET,
      // Pinned so verification can reject an algorithm/issuer/audience mismatch —
      // jwt.verify previously pinned none of these.
      { expiresIn: TOKEN_TTL, algorithm: ALG, issuer: ISS_HUMAN, audience: AUD }
    );

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), failedAttempts: 0 },
    });

    redis.publish('auth:login', JSON.stringify({ userId: user.id, username: user.username }));

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        mustChangePwd: user.mustChangePwd,
        // A timestamp, not the image: it tells the client an avatar EXISTS and
        // doubles as the cache-busting token for GET /api/auth/avatar/:id, so
        // a new photo appears immediately instead of after the 5-minute
        // private cache expires. Null means "no photo — draw the monogram".
        avatarUpdatedAt: user.avatarUpdatedAt,
        roles: ctx.roles,
        permissions: ctx.permissions,
      },
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Mint the session token for an authenticated user. Shared by password and
// Google sign-in so the two can never drift apart on claims, TTL or pinning.
async function issueSession(user, res) {
  const ctx = await loadUserContext(user.id);
  const token = jwt.sign(
    {
      sub: user.id,
      username: user.username,
      displayName: user.displayName,
      roles: ctx.roles,
      permissions: ctx.permissions,
      jti: crypto.randomUUID(),
      // See the note on the password-login sign above.
      iatMs: Date.now(),
    },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL, algorithm: ALG, issuer: ISS_HUMAN, audience: AUD }
  );

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), failedAttempts: 0 },
  });

  redis.publish('auth:login', JSON.stringify({ userId: user.id, username: user.username }));

  return res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      mustChangePwd: user.mustChangePwd,
      avatarUpdatedAt: user.avatarUpdatedAt,
      roles: ctx.roles,
      permissions: ctx.permissions,
    },
  });
}

// GET /api/auth/config — what the sign-in screen needs to know before anyone has
// authenticated. Public on purpose: an OAuth *client* id is not a secret, and the
// web app cannot render the Google button without it.
router.get('/config', (_req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID || null,
    allowedEmailDomain: ALLOWED_EMAIL_DOMAIN,
  });
});

// POST /api/auth/google — sign in with a university Google account.
//
// Accounts are NOT auto-provisioned. Google proves who someone is; it says
// nothing about what they may do here, and this system is default-deny. So the
// address must already belong to a User an admin created, or sign-in is refused
// with a message that says exactly that.
router.post('/google', async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
    }

    // Two ways in, one policy. `credential` is an ID token from Google's own
    // rendered button; `accessToken` comes from the OAuth token flow behind our
    // custom-styled button. Both end up as a verified address in this domain.
    const { credential, accessToken } = req.body || {};
    if (!credential && !accessToken) {
      return res.status(400).json({ error: 'Missing Google credential.' });
    }

    let profile;
    try {
      profile = credential
        ? await verifyGoogleIdToken(credential, {
            clientId: GOOGLE_CLIENT_ID,
            allowedDomain: ALLOWED_EMAIL_DOMAIN,
          })
        : await verifyGoogleAccessToken(accessToken, {
            clientId: GOOGLE_CLIENT_ID,
            allowedDomain: ALLOWED_EMAIL_DOMAIN,
          });
    } catch (err) {
      // The domain rule is a legitimate thing to tell the user; a signature or
      // audience failure is not, so it is logged rather than echoed.
      console.warn('[Auth] Google sign-in rejected:', err.message);
      return res.status(401).json({ error: err.message });
    }

    const user = await prisma.user.findFirst({
      where: { email: { equals: profile.email, mode: 'insensitive' } },
    });
    if (!user) {
      return res.status(403).json({
        error: `No InnSight account is linked to ${profile.email}. Ask an administrator to add you.`,
      });
    }
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ error: `Account ${user.status.toLowerCase()}.` });
    }

    return await issueSession(user, res);
  } catch (err) {
    console.error('[Auth] Google login error:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/auth/access-request — the "Sign Up" link.
//
// This creates NO account and grants NOTHING. It records that someone wants
// access, for an admin to approve in Users. Public by necessity (the asker has
// no session yet), so it is rate-limited at the gateway and restricted to the
// university domain.
router.post('/access-request', async (req, res) => {
  try {
    const fullName = String(req.body?.fullName || '').trim();
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    const note = String(req.body?.note || '').trim() || null;

    if (!fullName || !email) {
      return res.status(400).json({ error: 'Your name and university email are required.' });
    }
    if (fullName.length > 120 || (note && note.length > 500)) {
      return res.status(400).json({ error: 'That is longer than this form accepts.' });
    }
    if (!email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
      return res.status(400).json({ error: `Use your @${ALLOWED_EMAIL_DOMAIN} university email.` });
    }

    // Never confirm or deny that an account already exists — that would turn
    // this open form into an account-enumeration oracle. The response below is
    // identical either way.
    const existing = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    if (!existing) {
      await prisma.accessRequest.upsert({
        where: { email },
        update: { fullName, note, status: 'PENDING', createdAt: new Date() },
        create: { email, fullName, note },
      });
    }

    return res.status(202).json({
      ok: true,
      message: 'Request received. An administrator will review it and set up your account.',
    });
  } catch (err) {
    console.error('[Auth] Access request error:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/auth/me
router.get('/me', verifyToken, async (req, res) => {
  try {
    const ctx = await loadUserContext(req.user.sub);
    if (!ctx) return res.status(404).json({ error: 'User not found.' });
    const { user } = ctx;
    res.json({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      status: user.status,
      mustChangePwd: user.mustChangePwd,
      lastLoginAt: user.lastLoginAt,
      avatarUpdatedAt: user.avatarUpdatedAt,
      roles: ctx.roles,
      permissions: ctx.permissions,
    });
  } catch (err) {
    console.error('[Auth] Me error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', verifyToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const ok = await bcrypt.compare(currentPassword || '', user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Current password incorrect.' });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePwd: false },
    });
    // A password change must invalidate every session the account has open —
    // otherwise a stolen token keeps working for the rest of its 12h TTL, which
    // defeats the entire point of changing the password.
    await revocation.revokeAllForUser(user.id);
    redis.publish('auth:password_changed', JSON.stringify({ userId: user.id }));
    res.json({ success: true, otherSessionsRevoked: true });
  } catch (err) {
    console.error('[Auth] Change password error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Self-service account identity ───────────────────────────────────────────
// Username and email could previously only be changed through
// PATCH /api/users/:id, which is requireRole('ADMIN','MANAGER') — so a front
// desk agent could not correct their own misspelled name without an admin.
//
// Both require the CURRENT PASSWORD. These fields are login identifiers: a
// stolen 12-hour token should not be enough to move an account onto an
// attacker's email address, which is the first step of a takeover.
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
// Deliberately conservative rather than RFC-complete: one @, no whitespace, a
// dot in the domain. The aim is to reject typos, not to be a parser.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;

async function reauthenticate(userId, currentPassword) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { error: 404 };
  const ok = await bcrypt.compare(currentPassword || '', user.passwordHash);
  if (!ok) return { error: 401 };
  return { user };
}

// POST /api/auth/change-username
router.post('/change-username', verifyToken, async (req, res) => {
  try {
    const { newUsername, currentPassword } = req.body || {};
    const next = String(newUsername || '').trim();
    if (!USERNAME_RE.test(next)) {
      return res.status(400).json({
        error: '3–32 characters, using letters, numbers, dot, underscore or hyphen only.',
      });
    }
    const { user, error } = await reauthenticate(req.user.sub, currentPassword);
    if (error === 404) return res.status(404).json({ error: 'User not found.' });
    if (error === 401) return res.status(401).json({ error: 'Current password incorrect.' });
    if (next === user.username) {
      return res.status(400).json({ error: 'That is already your username.' });
    }
    await prisma.user.update({ where: { id: user.id }, data: { username: next } });
    // The username is a JWT claim, so every existing token still carries the old
    // one. Revoking forces a fresh sign-in and keeps token contents truthful.
    await revocation.revokeAllForUser(user.id);
    redis.publish(
      'auth:username_changed',
      JSON.stringify({ userId: user.id, username: next })
    );
    res.json({ success: true, username: next, reauthRequired: true });
  } catch (err) {
    // Unique violation — someone else holds it. Checked by catching rather than
    // by a prior SELECT, because between that SELECT and the UPDATE the name
    // could be taken by a concurrent request.
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    console.error('[Auth] Change username error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/auth/change-email
router.post('/change-email', verifyToken, async (req, res) => {
  try {
    const { newEmail, currentPassword } = req.body || {};
    // Lowercased so the unique index cannot hold Admin@x and admin@x at once.
    const next = String(newEmail || '')
      .trim()
      .toLowerCase();
    if (!EMAIL_RE.test(next) || next.length > 254) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    const { user, error } = await reauthenticate(req.user.sub, currentPassword);
    if (error === 404) return res.status(404).json({ error: 'User not found.' });
    if (error === 401) return res.status(401).json({ error: 'Current password incorrect.' });
    if (next === (user.email || '').toLowerCase()) {
      return res.status(400).json({ error: 'That is already your email address.' });
    }
    await prisma.user.update({ where: { id: user.id }, data: { email: next } });
    redis.publish('auth:email_changed', JSON.stringify({ userId: user.id }));
    // NOT revoked: unlike the username, the email is not a token claim, so
    // existing sessions stay accurate and there is nothing to force.
    res.json({ success: true, email: next });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'That email address is already in use.' });
    }
    console.error('[Auth] Change email error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Profile photo ───────────────────────────────────────────────────────────
const AVATAR_MAX_BYTES = 4 * 1024 * 1024;

// Type is decided by the FILE, never by the request. A caller controls its own
// Content-Type header, and whatever we store here is echoed back as the
// Content-Type of the image response — so trusting the header would let someone
// upload one thing and have the browser render it as another.
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // WEBP: "RIFF" .... "WEBP"
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

// POST /api/auth/avatar — raw image bytes, not multipart.
//
// express.raw parses this route only; multipart would need a new dependency
// (multer/busboy) to carry a single file, and base64 in JSON would inflate a 4MB
// image to ~5.5MB of request body for no benefit.
router.post(
  '/avatar',
  verifyToken,
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: AVATAR_MAX_BYTES }),
  async (req, res) => {
    try {
      // An unsupported Content-Type leaves express.raw's matcher unmatched, so
      // the body arrives as {} rather than a Buffer.
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Send raw PNG, JPEG or WEBP image bytes.' });
      }
      if (req.body.length > AVATAR_MAX_BYTES) {
        return res.status(413).json({ error: 'Image must be 4MB or smaller.' });
      }
      const mime = sniffImageMime(req.body);
      if (!mime) {
        return res
          .status(400)
          .json({ error: 'That file is not a valid PNG, JPEG or WEBP image.' });
      }
      await prisma.user.update({
        where: { id: req.user.sub },
        data: { avatarData: req.body, avatarMime: mime, avatarUpdatedAt: new Date() },
      });
      redis.publish('auth:avatar_changed', JSON.stringify({ userId: req.user.sub }));
      res.json({ success: true, mime, bytes: req.body.length });
    } catch (err) {
      console.error('[Auth] Avatar upload error:', err.message);
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
);

// DELETE /api/auth/avatar — back to the letter monogram.
router.delete('/avatar', verifyToken, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.sub },
      data: { avatarData: null, avatarMime: null, avatarUpdatedAt: null },
    });
    redis.publish('auth:avatar_changed', JSON.stringify({ userId: req.user.sub }));
    res.json({ success: true });
  } catch (err) {
    console.error('[Auth] Avatar delete error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/auth/avatar/:userId — any signed-in user may see a colleague's photo
// (they appear beside names throughout the app); anonymous callers may not.
router.get('/avatar/:userId', verifyToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: { avatarData: true, avatarMime: true, avatarUpdatedAt: true },
    });
    if (!user?.avatarData || !user.avatarMime) {
      return res.status(404).json({ error: 'No avatar set.' });
    }
    // Prisma hands `Bytes` back as a Uint8Array, NOT a Buffer. res.send() treats
    // a Uint8Array as a plain object and JSON-stringifies it, so this route
    // served `{"0":137,"1":80,...}` — labelled image/png — instead of the image.
    // res.end() also leaves the Content-Type exactly as set, where res.send()
    // appends "; charset=utf-8" to it.
    const bytes = Buffer.from(user.avatarData);
    res.setHeader('Content-Type', user.avatarMime);
    res.setHeader('Content-Length', bytes.length);
    // The stored mime came from magic bytes, but tell the browser not to
    // second-guess it either way.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Belt and braces: even if something non-image were ever served from here,
    // this origin would not execute it.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
    // Private: this is behind auth, so a shared cache must not keep it. The
    // client busts it with the avatarUpdatedAt version after an upload.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(bytes);
  } catch (err) {
    console.error('[Auth] Avatar fetch error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/auth/logout — REVOKES the presented token.
//
// This used to publish an event and return success without invalidating anything,
// so the JWT stayed usable for its full 12h TTL. On a shared front-desk machine
// that meant "log out" left a working credential behind.
router.post('/logout', verifyToken, async (req, res) => {
  const revoked = await revocation.revokeToken(req.user);
  redis.publish('auth:logout', JSON.stringify({ userId: req.user.sub }));
  // `revoked:false` means Redis was unreachable and the token is still technically
  // valid until it expires — say so rather than implying a guarantee we didn't make.
  res.json({ success: true, tokenRevoked: revoked });
});

module.exports = router;
