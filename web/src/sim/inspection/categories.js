// Every fault category the flag menu can offer and grading can explain.
//
// Two sources, one list:
//   • the six BUILT-INS, which live in defects.js next to the code that injects
//     them — they are behaviour, not data
//   • teacher-authored CUSTOM categories, which are rows in InspectionCategory
//     and therefore shared by every scenario and every room
//
// Custom categories used to be stored inside each scenario, so one authored for
// room 201 did not exist for room 202. They are pushed in here instead (see
// categorySync.js) so a category is authored once and offered everywhere.
//
// No network code in this module on purpose: node --test imports it directly.
import { DEFECTS } from './defects.js';

/**
 * Shape every consumer sees: { id, label, title, why, feedback, custom }.
 *
 * `label` is what the flag menu shows; `title` is what the assessment prints.
 * The six built-ins carry both (a defect's `title` is its heading), and for a
 * teacher-authored category the two are the same string — so every consumer can
 * read either without knowing where the category came from.
 */
const asCategory = (d, custom) => {
  const text = d.label ?? d.title;
  return {
    id: d.id,
    label: text,
    title: d.title ?? text,
    why: d.why,
    feedback: d.feedback ?? null,
    custom,
  };
};

export const BUILTIN_CATEGORIES = DEFECTS.map((d) => asCategory(d, false));
const BUILTIN_IDS = new Set(BUILTIN_CATEGORIES.map((c) => c.id));

/** A teacher-authored id, as minted by the server: custom_<slug>. */
export const isCustomCategoryId = (id) =>
  typeof id === 'string' && /^custom_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(id);

const custom = new Map();

/**
 * Replace the custom categories with what the server holds.
 *
 * Retired categories (`active: false`) are STILL registered: a scenario saved
 * earlier may tag a fixture with one, and dropping it would turn that fault into
 * something the flag menu cannot offer — unwinnable for the student. They are
 * excluded from `offerableCategories()` instead, so nothing new can use them.
 *
 * @param {Array<{id, label, why, feedback, active}>} rows
 */
export function setCustomCategories(rows) {
  custom.clear();
  for (const r of rows || []) {
    if (!r || !isCustomCategoryId(r.id)) continue;
    // A category with no `why` cannot be graded — it would mark a student wrong
    // with a blank reason. Skip it rather than register something unexplainable.
    if (typeof r.why !== 'string' || !r.why.trim()) continue;
    if (BUILTIN_IDS.has(r.id)) continue; // never let data shadow behaviour
    const label = String(r.label || r.id);
    custom.set(r.id, {
      id: r.id,
      label,
      title: label,
      why: r.why.trim(),
      feedback: typeof r.feedback === 'string' && r.feedback.trim() ? r.feedback.trim() : null,
      custom: true,
      active: r.active !== false,
    });
  }
}

/** Every registered category, built-ins first. Includes retired customs. */
export function allCategories() {
  return [...BUILTIN_CATEGORIES, ...custom.values()];
}

/** What a teacher or student may CHOOSE — retired customs excluded. */
export function offerableCategories() {
  return [...BUILTIN_CATEGORIES, ...[...custom.values()].filter((c) => c.active)];
}

/** Resolve an id to a category, or null. Grading reads `why`/`feedback` here. */
export function categoryById(id) {
  if (!id) return null;
  const b = BUILTIN_CATEGORIES.find((c) => c.id === id);
  if (b) return b;
  return custom.get(id) || null;
}

/** True when this id can be graded — i.e. it has an explanation to print. */
export function isKnownCategory(id) {
  return !!categoryById(id);
}
