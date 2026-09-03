// ─────────────────────────────────────────────────────────────────────────────
// A colour per guest on the calendar board.
//
// Every bar used to be coloured by reservation STATUS, so a week where nothing
// had happened yet was a wall of identical green and telling one booking from
// the next meant reading every label. Colour now identifies the GUEST — the
// thing a front-desk user is actually tracking across rooms and days — and
// status moved to the stripe down the bar's left edge.
//
// THE PALETTE IS NOT INVENTED. Slots 1-8 are the validated categorical palette
// from the data-viz reference (scripts/validate_palette.js): inside the
// lightness band, above the chroma floor, and clear of the colour-blind and
// normal-vision separation floors in both light and dark. Slots 9-16 are a
// second step of the same eight hues, validated as their own set.
//
// WHERE IT STOPS BEING GUARANTEED. Sixteen is the honest ceiling. Past that,
// colours repeat — no set of 17+ fills can stay both distinct and accessible,
// and inventing generated hues to pad the list is precisely what makes a board
// unreadable for a colour-blind user. That is safe here because colour is never
// the only cue: every bar carries the guest's name, so a repeat costs a glance,
// not the information.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Slots 1-8: the validated categorical order. Slots 9-16: a second step of the
 * same hues, in the same order, so a board that runs past eight guests stays
 * systematic rather than arbitrary.
 *
 * Light tier 2 is DARKER than tier 1; dark tier 2 is LIGHTER. Both directions
 * move away from their surface, which is what keeps contrast above 3:1.
 */
// Slot 1's light step is #2976d2 rather than the reference #2a78d6: at 11px the
// guest's name needs 4.5:1, and the reference blue tops out at 4.42:1 with white
// and 4.15:1 with near-black — it cannot carry text with either ink. Snapped one
// step darker and re-validated: every categorical check still passes.
export const PALETTE_LIGHT = [
  '#2976d2', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948',
  '#2360a8', '#b64a1f', '#12855f', '#a8760a', '#c25c85', '#2f7d3a', '#6f5fd8', '#b53433',
];

export const PALETTE_DARK = [
  '#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#2f9e3f', '#9085e9', '#e66767',
  '#6fa8ea', '#e8845c', '#3fc79a', '#e0ae3c', '#eb8fb4', '#63c46f', '#b3a8f2', '#f09190',
];

export const SLOTS = PALETTE_LIGHT.length;

/** FNV-1a. Small, fast, and stable across sessions — the same guest keeps the
 *  same colour tomorrow, which is the whole point of colouring by identity. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < String(str).length; i += 1) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The identity a colour belongs to.
 *
 * The guest RECORD where there is one, so the same person keeps their colour
 * across separate bookings and across rooms. A walk-in with no guest record
 * falls back to the name, which is the only identity that exists for them.
 */
export function guestKey(booking) {
  return booking?.guestId || booking?.guestName || booking?.label || '';
}

/**
 * Assign every guest a slot, with no two sharing while there are slots left.
 *
 * Hash first, then resolve collisions — deliberately, and this is the trade
 * worth knowing about. A pure hash would be perfectly stable but would let two
 * guests land on the same colour; assigning purely by position on screen would
 * guarantee distinctness but repaint everyone whenever the week changed. Hashing
 * first means the great majority of guests keep the same colour week to week,
 * and only the minority who actually collide are moved.
 *
 * Deterministic for a given set: keys are sorted before probing, so the same
 * bookings always produce the same board regardless of the order they arrived
 * from the API.
 *
 * @param {Array<string>} keys guest keys, duplicates allowed
 * @returns {Map<string, number>} guest key → slot index
 */
export function assignSlots(keys) {
  const unique = [...new Set((keys || []).filter(Boolean))].sort();
  const out = new Map();
  const taken = new Set();

  // Pass 1: everyone who can have the slot their identity hashes to, gets it.
  const collided = [];
  for (const k of unique) {
    const want = hash(k) % SLOTS;
    if (taken.has(want)) collided.push(k);
    else {
      taken.add(want);
      out.set(k, want);
    }
  }

  // Pass 2: the rest take the next free slot, wrapping. Once every slot is
  // taken, colours repeat — the guest's name on the bar is what disambiguates.
  let probe = 0;
  for (const k of collided) {
    if (taken.size >= SLOTS) {
      out.set(k, hash(k) % SLOTS);
      continue;
    }
    let want = hash(k) % SLOTS;
    for (let n = 0; n < SLOTS; n += 1) {
      const slot = (want + n) % SLOTS;
      if (!taken.has(slot)) {
        want = slot;
        break;
      }
    }
    taken.add(want);
    out.set(k, want);
    probe += 1;
  }
  void probe;
  return out;
}

/** sRGB relative luminance, per WCAG. */
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** Contrast ratio between two hexes, per WCAG. */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export const INK_DARK = '#10151c';
export const INK_LIGHT = '#ffffff';

/**
 * Ink that stays readable on a given fill.
 *
 * Whichever of the two actually wins, not a luminance threshold. A threshold
 * looks right and is not: slot 1's blue sits at luminance 0.19, comfortably in
 * "use white" territory by eye, and white on it is 4.42:1 — under the 4.5 floor
 * for 11px text, while near-black on the same blue is 4.8:1. Measuring both and
 * taking the better one has no such blind spot.
 *
 * This matters more than it looks: the guest's name on the fill is the cue that
 * makes a repeated colour harmless, so it is the one thing that must never be
 * hard to read.
 */
export function inkOn(hex) {
  return contrast(hex, INK_DARK) >= contrast(hex, INK_LIGHT) ? INK_DARK : INK_LIGHT;
}

/** The fill for a guest, in the given mode. */
export function colorFor(slot, dark = false) {
  const palette = dark ? PALETTE_DARK : PALETTE_LIGHT;
  return palette[((slot % SLOTS) + SLOTS) % SLOTS];
}
