const Redis = require('ioredis');
const CATALOGUE = require('./navSections.json');

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar Visibility — the server half.
//
// WHAT THIS IS
// ------------
// An admin can hide sections of the product from a role (Settings → Edit System
// Layout). Hiding a sidebar link in the browser is decoration: the route still
// resolves if the URL is typed, and the APIs behind it still answer. This module
// is what makes the setting mean something, by refusing the requests that belong
// to a section the caller can no longer reach.
//
// SUBTRACTIVE, NEVER ADDITIVE
// ---------------------------
// The stored config can only take sections away from what a role already has in
// navSections.json's `roles`. It is never consulted to GRANT anything, and every
// existing requireRole guard stays exactly where it is. A checkbox is therefore
// incapable of handing a housekeeper the folio ledger — the worst a bad config
// can do is lock somebody out of a page they were entitled to, which an admin
// fixes by ticking the box again.
//
// WHY A UNION OF PREFIXES, NOT A PAGE-TO-API MAP
// ----------------------------------------------
// Pages share APIs. /api/folios is read by the Folios page, by the folio tab of
// Arrivals, by Amenities and by Reservation Detail. A naive "hiding Folios
// blocks /api/folios" rule would break three other screens the admin never
// touched.
//
// So a prefix is allowed while ANY still-visible section lists it. Hiding Folios
// from Front Desk leaves /api/folios reachable because Arrivals still needs it;
// hide every section that lists /api/folios and only then does the prefix close.
// That is the honest reading of "this role has no business here any more", and
// it cannot over-block.
//
// The flip side, stated plainly: hiding ONE page rarely closes an API on its
// own. This layer is page-level access control. What stops a role reading data
// it was never entitled to is the requireRole guard on each route, which is
// unchanged and still the real boundary.
//
// FAIL-OPEN
// ---------
// If Redis is unreachable the config cannot be read and every section is treated
// as visible. Same trade-off, for the same reason, as tokenRevocation.js: a
// Redis blip must not lock the whole front desk out of the PMS mid-shift.
// ─────────────────────────────────────────────────────────────────────────────

// Where the resolved config lives for every service to read. The auth service
// owns the durable copy in Postgres and mirrors it here on write and on boot.
const CONFIG_KEY = 'authz:nav_hidden';

// Read on every authenticated request, so cache it in-process. Five seconds
// means a layout change reaches every replica within five seconds, and keeps
// Redis off the hot path during a burst. Mirrors EPOCH_TTL_MS next door.
const CONFIG_TTL_MS = 5000;

const ITEMS = CATALOGUE.sections.flatMap((s) => s.items);
const BY_KEY = new Map(ITEMS.map((i) => [i.key, i]));

// Every prefix any section claims. A request whose path matches none of these is
// not section-scoped at all (health probes, metrics, docs) and is left alone —
// this module only ever narrows paths it can positively account for.
const ALL_SCOPED_PREFIXES = [...new Set(ITEMS.flatMap((i) => i.api || []))];

function pathMatches(path, prefix) {
  // Prefix match on a SEGMENT boundary. A bare `startsWith` would let /api/roomsX
  // match /api/rooms, and — the one that matters — would let the /api/room-types
  // prefix be satisfied by a rule written for /api/room.
  return path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?');
}

// Which sections a set of roles can see, given the stored config.
//
// A user holding two roles keeps a section if EITHER role still has it, matching
// how hasRole() has always worked ("some", not "every"). A manager who is also
// covering the front desk does not lose Reports because Front Desk had it hidden.
function visibleSections(roles = [], hidden = {}) {
  const held = Array.isArray(roles) ? roles : [];
  return ITEMS.filter((item) => {
    // The baseline first: the config is never asked about a section the role
    // could not reach in the first place.
    if (item.roles && !item.roles.some((r) => held.includes(r))) return false;
    if (item.core) return true;
    return held.some((role) => !(hidden[role] || []).includes(item.key));
  }).map((i) => i.key);
}

// The API prefixes those sections justify, unioned. See the note above on why
// this is a union and not a per-page map.
function allowedPrefixes(roles = [], hidden = {}) {
  const keys = new Set(visibleSections(roles, hidden));
  const out = new Set(CATALOGUE.alwaysAllow);
  for (const key of keys) for (const p of BY_KEY.get(key)?.api || []) out.add(p);
  return [...out];
}

// Is this request inside a section the caller has LOST — as opposed to one they
// never had? `false` for anything this module cannot positively account for.
//
// The baseline test in the middle is the important one. Without it this guard
// answered every authorisation failure it happened to recognise, including the
// ordinary ones that requireRole has always handled, and it answered them with
// "an administrator hid this" — which was a plain lie on a system where nobody
// had configured anything yet. A path outside the caller's baseline is not this
// module's business: fall through and let the role guard say "Forbidden." as it
// always did.
//
// It also means an empty config denies nothing at all, anywhere. That is the
// state a fresh install is in, and it should be indistinguishable from the
// system before this feature existed.
function isDenied(path, roles, hidden) {
  if (!ALL_SCOPED_PREFIXES.some((p) => pathMatches(path, p))) return false;
  if (CATALOGUE.alwaysAllow.some((p) => pathMatches(path, p))) return false;
  // What this role could reach with nothing hidden.
  if (!allowedPrefixes(roles, {}).some((p) => pathMatches(path, p))) return false;
  return !allowedPrefixes(roles, hidden).some((p) => pathMatches(path, p));
}

// Strip an admin's config down to what it is allowed to express: known roles,
// known section keys, and nothing core. Applied on write AND on read, so a row
// written by an older build — or edited by hand — cannot widen what the guard
// enforces or hide a section that would strand its user.
function sanitizeConfig(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const role of CATALOGUE.configurableRoles) {
    const keys = Array.isArray(raw[role]) ? raw[role] : [];
    const clean = [...new Set(keys)].filter((k) => BY_KEY.has(k) && !BY_KEY.get(k).core);
    if (clean.length) out[role] = clean;
  }
  return out;
}

function createNavScope({
  redisUrl = process.env.REDIS_URL || 'redis://localhost:6379',
  label = 'authz',
} = {}) {
  let redis = null;
  let warned = false;
  let cache = { value: {}, at: 0 };

  function client() {
    if (redis) return redis;
    try {
      redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
      redis.on('error', (e) => {
        if (!warned) {
          console.warn(`[${label}] nav-scope redis unavailable — every section treated as visible:`, e.message);
          warned = true;
        }
      });
    } catch (e) {
      console.warn(`[${label}] could not create nav-scope redis client:`, e.message);
      redis = null;
    }
    return redis;
  }

  async function readConfig() {
    if (Date.now() - cache.at < CONFIG_TTL_MS) return cache.value;
    const r = client();
    if (!r) return {};
    try {
      const raw = await r.get(CONFIG_KEY);
      const value = sanitizeConfig(raw ? JSON.parse(raw) : {});
      cache = { value, at: Date.now() };
      return value;
    } catch (e) {
      if (!warned) {
        console.warn(`[${label}] nav-scope read failed — allowing request:`, e.message);
        warned = true;
      }
      // Do NOT cache a failure: the next request should try Redis again rather
      // than run blind for the whole TTL.
      return {};
    }
  }

  // Publish the durable config out to every service. Auth-service only.
  async function writeConfig(config) {
    const r = client();
    if (!r) return false;
    const clean = sanitizeConfig(config);
    await r.set(CONFIG_KEY, JSON.stringify(clean));
    cache = { value: clean, at: Date.now() };
    return true;
  }

  // Called from verifyToken once req.user is set, rather than mounted as its own
  // middleware: the nine services mount their routers differently (some wrap the
  // whole /api tree in verifyToken, the auth service guards route by route), and
  // hanging this off the one thing they all share is the only placement that
  // cannot be forgotten in one of them.
  async function denyIfOutOfScope(req, res) {
    // Machine-to-machine calls are not a person navigating a sidebar.
    if (req.user?.svc) return false;
    const path = (req.originalUrl || req.url || '').split('?')[0];
    const hidden = await readConfig();
    if (!isDenied(path, req.user?.roles || [], hidden)) return false;
    res.status(403).json({
      error: 'This section has been hidden for your role by an administrator.',
    });
    return true;
  }

  return {
    readConfig,
    writeConfig,
    denyIfOutOfScope,
    sectionsFor: async (roles) => visibleSections(roles, await readConfig()),
    disconnect: () => redis?.disconnect?.(),
  };
}

module.exports = {
  createNavScope,
  visibleSections,
  allowedPrefixes,
  isDenied,
  sanitizeConfig,
  CATALOGUE,
  CONFIG_KEY,
};
