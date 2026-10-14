// Pure rules for creating teacher-authored fault categories, so they can be unit
// tested without a database or an Express app.

const crypto = require('crypto');

const labelKey = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');

// The headings of the six built-in categories (web/src/sim/inspection/defects.js
// titles). A custom category with the same name would appear twice in the flag
// menu. Must stay in step with that file.
const BUILTIN_LABELS = [
  'Room set-up does not match the booking',
  'Not enough amenities for the party size',
  'Walkway or exit is blocked',
  'Cleaning equipment or chemicals left behind',
  'Room still looks used — not reset to standard',
  'Minibar or snack tray not properly stocked',
];
const BUILTIN_LABEL_KEYS = new Set(BUILTIN_LABELS.map(labelKey));

const randomSuffix = () => crypto.randomBytes(3).toString('hex');

/**
 * custom_<slug> for a label, or '' when the label has no ASCII letters or digits
 * to build a slug from (e.g. a label written entirely in another script).
 */
function slugify(label) {
  const slug = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    // The slice can land just after an underscore, leaving a trailing one that
    // fails the id pattern.
    .replace(/_+$/g, '');
  return slug ? `custom_${slug}` : '';
}

/**
 * Decide what creating a category with this label should do, given every
 * existing row. Never silently overwrites: POST used to be an upsert on the
 * slug, so "Pest!" and "Pest?" (same slug) replaced each other.
 *
 * @param {string} label
 * @param {Array<{id: string, label: string, active: boolean}>} rows
 * @param {() => string} [rand] suffix source, injectable for tests
 * @returns {{action: 'create'|'revive', id: string} | {error: string, status: number}}
 */
function planCategoryCreate(label, rows, rand = randomSuffix) {
  const key = labelKey(label);
  if (BUILTIN_LABEL_KEYS.has(key)) {
    return { error: `"${label}" is already a built-in category — pick a different name.`, status: 400 };
  }
  const same = rows.find((r) => labelKey(r.label) === key);
  if (same) {
    if (same.active) return { error: `A category named "${same.label}" already exists.`, status: 409 };
    // The same name, retired: bring it back rather than minting a twin.
    return { action: 'revive', id: same.id };
  }
  const base = slugify(label) || 'custom';
  let id = base === 'custom' ? `custom_${rand()}` : base;
  // A different label that slugs the same (or an id already taken): suffix it.
  for (let i = 0; i < 5 && rows.some((r) => r.id === id); i += 1) id = `${base}_${rand()}`;
  if (rows.some((r) => r.id === id)) return { error: 'Could not generate a unique id; try another name.', status: 409 };
  return { action: 'create', id };
}

module.exports = { slugify, planCategoryCreate, labelKey, BUILTIN_LABELS };
