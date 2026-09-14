const express = require('express');
const { verifyToken, requireRole, navScope } = require('../middleware/auth');
const { CATALOGUE, sanitizeConfig, visibleSections } = require('../lib/navScope');

const router = express.Router();
const prisma = require('../lib/prisma');

// ── Sidebar Visibility — Settings → Edit System Layout ───────────────────────
// Which sections of the product each role can reach. Postgres is the durable
// copy; Redis is how the other eight services see it without any of them
// needing to call this one on every request (lib/navScope.js).
//
// The config only ever SUBTRACTS from navSections.json's `roles` baseline, so
// nothing here can widen anyone's access — see the header of navScope.js.
const SETTING_KEY = 'nav.hidden';

async function loadConfig() {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return {};
  try {
    return sanitizeConfig(JSON.parse(row.value));
  } catch {
    // A row that will not parse is a corrupt config, and the safe reading of a
    // corrupt "what is hidden" list is that nothing is.
    console.warn('[Auth] nav.hidden is not valid JSON — treating every section as visible.');
    return {};
  }
}

// Postgres survives a restart; Redis is what the request path actually reads.
// Called on boot as well as on write, so a cold Redis (or a flushed one) is
// repopulated rather than silently running with every section visible.
async function publish() {
  const config = await loadConfig();
  await navScope.writeConfig(config).catch((e) => {
    console.warn('[Auth] could not publish nav visibility to Redis:', e.message);
  });
  return config;
}

// GET /api/settings/nav-visibility — the catalogue plus the current map. ADMIN
// only: it is the shape of everyone else's access, and MANAGER is one of the
// roles it configures.
router.get('/settings/nav-visibility', verifyToken, requireRole('ADMIN'), async (_req, res) => {
  try {
    res.json({
      // The editor renders from this rather than from a list of its own, so a
      // section added to navSections.json appears in the grid with no web change.
      sections: CATALOGUE.sections.map((s) => ({
        label: s.label,
        items: s.items.map((i) => ({
          key: i.key,
          label: i.label,
          roles: i.roles || null,
          core: !!i.core,
        })),
      })),
      roles: CATALOGUE.configurableRoles,
      hidden: await loadConfig(),
    });
  } catch (err) {
    console.error('[Auth] Read nav visibility error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/settings/nav-visibility — replace the map. Body: { hidden: { ROLE: [key…] } }.
router.put('/settings/nav-visibility', verifyToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const { hidden } = req.body;
    if (!hidden || typeof hidden !== 'object' || Array.isArray(hidden)) {
      return res.status(400).json({ error: 'hidden must be an object of { ROLE: [sectionKey, …] }.' });
    }
    // Name what is being dropped instead of accepting it silently. Quietly
    // discarding "hide Settings from ADMIN" would leave the admin believing they
    // had saved something they had not.
    const rejected = [];
    for (const [role, keys] of Object.entries(hidden)) {
      if (!CATALOGUE.configurableRoles.includes(role)) {
        rejected.push(`role ${role}`);
        continue;
      }
      for (const key of Array.isArray(keys) ? keys : []) {
        const item = CATALOGUE.sections.flatMap((s) => s.items).find((i) => i.key === key);
        if (!item) rejected.push(`unknown section ${key}`);
        else if (item.core) rejected.push(`${item.label} (always visible)`);
      }
    }
    if (rejected.length) {
      return res.status(400).json({
        error: `Cannot hide: ${rejected.join(', ')}.`,
        // ADMIN is absent from configurableRoles on purpose: an admin who hid
        // Settings and Users from their own role would have removed the only
        // screen that could put them back.
        configurableRoles: CATALOGUE.configurableRoles,
      });
    }

    const clean = sanitizeConfig(hidden);
    const value = JSON.stringify(clean);
    await prisma.setting.upsert({
      where: { key: SETTING_KEY },
      create: { key: SETTING_KEY, value },
      update: { value },
    });
    await publish();
    // No token revocation: the guard reads the live config on each request
    // (5s cache), so a layout change takes effect within seconds without
    // signing anybody out mid-shift. The web re-reads its own effective list
    // from /api/auth/me on the next navigation.
    res.json({ hidden: clean });
  } catch (err) {
    console.error('[Auth] Write nav visibility error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/settings/my-sections — the signed-in user's own effective list, for
// the sidebar and the route guards. Every role may read its own; it says
// nothing about anybody else's.
router.get('/settings/my-sections', verifyToken, async (req, res) => {
  try {
    res.json({ sections: visibleSections(req.user?.roles || [], await loadConfig()) });
  } catch (err) {
    console.error('[Auth] Read my sections error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
module.exports.loadConfig = loadConfig;
module.exports.publish = publish;
