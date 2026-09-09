// ─────────────────────────────────────────────────────────────────────────────
// Grading for the inspection case study. React-free so the rules that decide a
// student's competency record are unit-testable on their own.
//
// Two dimensions, matching the rubric Assessment.jsx already renders:
//   • procedure (Did)      — did they find the fault?
//   • understanding (Why)  — did they correctly identify WHAT KIND of fault?
//
// Naming the category is not busywork. "Left behind by the attendant",
// "never restocked" and "not reset to standard" lead to three different
// corrective actions with three different people, so a student who spots a
// problem but misdiagnoses it has done half the job — which is exactly what
// GOOD procedure + ISSUES understanding encodes.
//
// PRECISION IS SCORED SEPARATELY, and that is the load-bearing decision here.
// Missing a real fault and condemning a clean room are different professional
// failures: one lets a guest walk into a bad room, the other burns an
// attendant's time and credibility. Folding false positives into the per-defect
// items would let "flag everything" score well, because every real fault would
// be caught. As its own line it cannot.
// ─────────────────────────────────────────────────────────────────────────────

// taskScore is the single, React-free source of the outcome vocabulary —
// importable by `node --test`, which cannot load a .jsx file. Assessment.jsx
// reads the same values.
import { GOOD, ISSUES, SKIPPED } from '../taskScore.js';
import { categoryById } from './categories.js';

const NO_ISSUE = 'ok';

/**
 * @param {object}   args
 * @param {object}   args.caseFile   the case the student inspected
 * @param {Array}    args.flags      [{ anchorId, defectId|null, chosenCategory }]
 *                                   defectId = what the anchor really was,
 *                                   chosenCategory = what the student picked
 * @param {number}   args.elapsedSec
 * @returns {Array} Assessment items: { key, label, procedure, understanding, note, feedback }
 */
export function scoreInspection({ caseFile, flags = [], elapsedSec = 0 }) {
  const injected = caseFile?.injected || [];
  const items = [];

  for (const id of injected) {
    // Any registered category — built-in or teacher-authored. Looking only in
    // DEFECTS meant a custom category resolved to nothing and the fault was
    // skipped entirely, so the student was never graded on it.
    const def = categoryById(id);
    if (!def) continue;

    // The student's verdict on this specific fault, if they reached it at all.
    const flag = flags.find((f) => f.defectId === id && f.chosenCategory !== NO_ISSUE);
    const passedOver = flags.find((f) => f.defectId === id && f.chosenCategory === NO_ISSUE);

    if (!flag) {
      items.push({
        key: id,
        label: def.title,
        procedure: ISSUES,
        understanding: null,
        elapsedSec,
        // Explicitly clearing a faulty object is a worse error than never
        // reaching it — the student looked straight at it and signed it off.
        note: passedOver
          ? `Missed — you inspected this and marked it correct. ${def.why}`
          : `Missed — this was never flagged. ${def.why}`,
        feedback: def.feedback,
      });
      continue;
    }

    const rightCategory = flag.chosenCategory === id;
    items.push({
      key: id,
      label: def.title,
      procedure: GOOD,
      understanding: rightCategory ? GOOD : ISSUES,
      elapsedSec,
      note: def.why,
      feedback: rightCategory ? undefined : def.feedback,
    });
  }

  // ── Precision ──
  const falsePositives = flags.filter((f) => f.defectId === null && f.chosenCategory !== NO_ISSUE).length;
  let precision;
  if (falsePositives === 0) precision = GOOD;
  else if (falsePositives <= 2) precision = ISSUES;
  else precision = SKIPPED;

  items.push({
    key: 'precision',
    label: 'Inspection precision',
    procedure: precision,
    understanding: falsePositives === 0 ? GOOD : ISSUES,
    elapsedSec,
    note:
      falsePositives === 0
        ? 'Every item you raised was a genuine fault. Nothing clean was condemned.'
        : `${falsePositives} clean item${falsePositives === 1 ? ' was' : 's were'} reported as faulty.`,
    feedback:
      falsePositives === 0
        ? undefined
        : 'Raising faults that are not there costs as much credibility as missing real ones — it sends attendants back to rooms that were already correct. Inspect against the booking and the brand standard, and leave what conforms alone.',
  });

  return items;
}

/**
 * Whether a completed inspection is clean enough to sign the room off as
 * guest-ready: every injected defect was found AND correctly categorised, and
 * nothing clean was condemned. Partial credit (found but miscategorised, or a
 * defect missed) does not pass — the room goes back for re-cleaning instead.
 *
 * @param {Array} items  the array `scoreInspection` returns
 */
export function passesInspection(items) {
  return items.length > 0 && items.every((i) => i.procedure === GOOD && i.understanding === GOOD);
}
