// Per-page interactive guides. Each page has its own file in this folder; this
// index maps a URL to its guide and remembers which ones a user has already been
// shown.
//
// A guide file default-exports ONE guide, or an ARRAY of them when the same URL
// shows different screens to different roles (the dashboard does):
//   { key, title, roles?: ['ADMIN', ...], steps: [{ target?, title, body, try? }] }
// `target` is a CSS selector, normally a `data-tour="g-<page>-<thing>"` attribute
// added to the page. A step whose target is missing still shows, as a centred
// card, so a guide never breaks on a role or data state it did not expect.
// A guide with no steps is treated as "no guide for this page".
import dashboard from './dashboard';
import guests from './guests';
import folios from './folios';
import folioDetail from './folio-detail';
import reservations from './reservations';
import reservationNew from './reservation-new';
import reservationDetail from './reservation-detail';
import calendar from './calendar';
import arrivals from './arrivals';
import walkIn from './walk-in';
import housekeeping from './housekeeping';
import rooms from './rooms';
import amenities from './amenities';
import reports from './reports';
import revenue from './revenue';
import audit from './audit';
import users from './users';
import health from './health';
import settings from './settings';
import activity from './activity';
import messages from './messages';
import roomLayouts from './room-layouts';
import inspectionScenarios from './inspection-scenarios';

const REGISTRY = [
  ['/', dashboard],
  ['/guests', guests],
  ['/folios', folios],
  ['/folios/:id', folioDetail],
  ['/reservations', reservations],
  ['/reservations/new', reservationNew],
  ['/reservations/:id', reservationDetail],
  ['/calendar', calendar],
  ['/arrivals', arrivals],
  ['/walk-in', walkIn],
  ['/housekeeping', housekeeping],
  ['/rooms', rooms],
  ['/amenities', amenities],
  ['/reports', reports],
  ['/revenue', revenue],
  ['/audit', audit],
  ['/users', users],
  ['/health', health],
  ['/settings', settings],
  ['/activity', activity],
  ['/messages', messages],
  ['/room-layouts', roomLayouts],
  ['/inspection-scenarios', inspectionScenarios],
];

function toRegex(path) {
  return new RegExp('^' + path.replace(/:[^/]+/g, '[^/]+') + '/?$');
}
const MATCHERS = REGISTRY.map(([path, g]) => ({ path, re: toRegex(path), g }));
// Literal paths are tried before ':id' ones, so /reservations/new is not read as
// a reservation whose id is "new".
MATCHERS.sort((a, b) => a.path.includes(':') - b.path.includes(':'));

/** The guide for this URL for this user's roles, or null. */
export function guideForPath(pathname, hasRole) {
  const hit = MATCHERS.find((m) => m.re.test(pathname));
  if (!hit) return null;
  const list = Array.isArray(hit.g) ? hit.g : [hit.g];
  const g = list.find((x) => x.steps?.length && (!x.roles || (hasRole && hasRole(...x.roles))));
  return g || null;
}

// "Seen" is kept per browser and per user. The first-run tour is stored on the
// account; this is deliberately lighter — worst case a person sees a page guide
// once more on a new device, and nothing needs a database change.
const seenKey = (userId) => `innsight.guides.seen.${userId || 'anon'}`;

export function hasSeenGuide(userId, key) {
  try {
    return JSON.parse(localStorage.getItem(seenKey(userId)) || '[]').includes(key);
  } catch {
    return false;
  }
}

export function markGuideSeen(userId, key) {
  try {
    const seen = JSON.parse(localStorage.getItem(seenKey(userId)) || '[]');
    if (!seen.includes(key)) localStorage.setItem(seenKey(userId), JSON.stringify([...seen, key]));
  } catch {
    /* storage unavailable — the guide just shows again next visit */
  }
}
