// What counts as a room-layout key.
//
// A layout key is a room-type name. It used to be a whitelist of the four
// built-ins (Standard, Deluxe, Suite, Presidential), which meant a property
// could never author a layout for a room type it created itself — and room types
// ARE user-created (Rooms → Create room type). Saving such a layout failed with
// "Unknown room tier."
//
// So validity is a matter of SHAPE, not membership: start alphanumeric, then
// letters, digits, spaces, hyphens or underscores, 40 characters at most. That
// keeps the value safe as a URL path segment and as a database key while letting
// an admin name a tier whatever the property calls it. These routes are
// ADMIN/MANAGER-only, so this widens what an authorised admin can name, not who
// can write.
//
// It lives in its own module because it regressed once — a wholesale file revert
// put the whitelist back and nothing failed until a user tried to save. Now it
// has tests, and the rule has one home instead of being retyped per route.
//
// The web carries this same literal in two places so a bad name costs no round
// trip: KEY_RE in web/src/pages/RoomLayouts.jsx and the inline check in
// web/src/sim/RoomLayoutEditor.jsx. Change those together with this.
const TIER_KEY = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;

function badTier(tier) {
  return typeof tier !== 'string' || !TIER_KEY.test(tier);
}

module.exports = { TIER_KEY, badTier };
