import { useMemo } from 'react';
import { GOOD, ISSUES, SKIPPED, fmtDuration } from './taskScore';

// ─────────────────────────────────────────────────────────────────────────────
// End-of-game assessment — fully client-side, no scoring, no leaderboard.
//
// Each task is now judged on TWO dimensions:
//   • Procedure     — did they perform the task to standard?
//   • Understanding — did they know WHY (the knowledge probe)?
// A student can do the steps right yet fail the "why", or vice-versa — and the
// rubric shows both, with corrective feedback on what to review. This mirrors
// the course's rubric (Demonstration & Briefing counts as much as execution).
//
// items: [{ key, label, procedure, understanding, note, feedback }]
//   procedure:     GOOD | ISSUES | SKIPPED
//   understanding: GOOD | ISSUES | null (null = no probe / not reached)
//   feedback:      corrective text shown when understanding is ISSUES
// ─────────────────────────────────────────────────────────────────────────────

const MARK = {
  good: { icon: '✓', cls: 'good' },
  issues: { icon: '!', cls: 'issues' },
  skipped: { icon: '–', cls: 'skipped' },
  na: { icon: '·', cls: 'skipped' },
};

function score(outcome) {
  if (outcome === GOOD) return 1;
  if (outcome === ISSUES) return 0.5;
  return 0;
}

export function computeVerdict(items) {
  const attempted = items.filter((i) => i.procedure !== SKIPPED);
  if (!attempted.length) {
    return {
      tone: 'bad',
      title: 'Nothing to assess',
      blurb: 'You left before completing any task — there is nothing to evaluate yet.',
    };
  }
  // Combined mastery across both dimensions, averaged over ALL tasks.
  let total = 0;
  items.forEach((i) => {
    const proc = score(i.procedure);
    const know = i.understanding == null ? proc : score(i.understanding); // no-probe tasks lean on procedure
    total += (proc + know) / 2;
  });
  const ratio = total / items.length;
  const allDone = attempted.length === items.length;
  const knowGaps = items.filter((i) => i.understanding === ISSUES).length;

  if (allDone && ratio >= 0.95) {
    return {
      tone: 'great',
      title: 'Excellent — and you can explain why',
      blurb:
        'Every task done to standard, with the reasoning to back it up. This is real competence, not just clicking.',
    };
  }
  if (allDone && ratio >= 0.75) {
    return {
      tone: 'good',
      title: 'Competent',
      blurb: knowGaps
        ? 'You finished everything; a couple of the “why” answers need review (flagged below).'
        : 'Solid execution with minor slips to tighten up.',
    };
  }
  if (ratio >= 0.5) {
    return {
      tone: 'ok',
      title: 'Developing',
      blurb:
        'A real attempt, but some tasks were skipped, done incorrectly, or you weren’t sure of the reason behind them.',
    };
  }
  return {
    tone: 'bad',
    title: 'Needs practice',
    blurb:
      'Several tasks need another pass — both the steps and the reasoning. Review the flagged items and try again.',
  };
}

function Mark({ outcome, na }) {
  const m = outcome === GOOD ? MARK.good : outcome === ISSUES ? MARK.issues : na ? MARK.na : MARK.skipped;
  return (
    <span className={`as-mark as-${m.cls}`} aria-hidden="true">
      {m.icon}
    </span>
  );
}

export default function Assessment({
  heading,
  items,
  onSubmit,
  onResume,
  submitLabel = 'Submit & return',
  resumeLabel = 'Keep working',
}) {
  const verdict = useMemo(() => computeVerdict(items), [items]);
  const done = items.filter((i) => i.procedure !== SKIPPED).length;

  return (
    <div className="cg-end as-screen">
      <div className={`as-verdict as-${verdict.tone}`}>
        {heading && <div className="as-verdict-eyebrow">{heading}</div>}
        <h3>{verdict.title}</h3>
        <p>{verdict.blurb}</p>
        <span className="as-verdict-progress">
          {done} of {items.length} tasks attempted
        </span>
      </div>

      <div className="as-legend">
        <span>
          <span className="as-mark as-good">✓</span> to standard
        </span>
        <span>
          <span className="as-mark as-issues">!</span> needs work
        </span>
        <span>
          <span className="as-mark as-skipped">–</span> not attempted
        </span>
      </div>

      <ul className="as-rubric">
        {items.map((it) => (
          <li
            key={it.key}
            className={`as-item as-${it.procedure === SKIPPED ? 'skipped' : it.procedure === GOOD && it.understanding !== ISSUES ? 'good' : 'issues'}`}
          >
            <div className="as-item-marks">
              <span className="as-dim">
                <Mark outcome={it.procedure} /> Did
              </span>
              <span className="as-dim">
                <Mark outcome={it.understanding} na={it.procedure === SKIPPED} /> Why
              </span>
            </div>
            <div className="as-item-body">
              <strong>{it.label}</strong>
              {/* Per-station performance. Every activity emits stars, elapsed
                  time, slip count and whether the SOP was opened — but until
                  now the assessment dropped all four on the floor, so stations
                  that wanted their timing shown had to smuggle it into `note`
                  by hand. Showing it here is what makes the par time and slip
                  budget mean anything after the run. */}
              {typeof it.stars === 'number' && (
                <span className="as-perf">
                  <span className="as-stars">{'★'.repeat(it.stars)}{'☆'.repeat(3 - it.stars)}</span>
                  {typeof it.elapsedSec === 'number' && <span>{fmtDuration(it.elapsedSec)}</span>}
                  {it.slips > 0 && <span>{it.slips} slip{it.slips === 1 ? '' : 's'}</span>}
                  {it.usedReference && <span title="Opened the SOP during this station">📘 SOP</span>}
                </span>
              )}
              {it.note && <span className="as-note">{it.note}</span>}
              {it.understanding === ISSUES && it.feedback && (
                <span className="as-fix">📘 Review: {it.feedback}</span>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="as-actions">
        {onResume && (
          <button className="secondary" onClick={onResume}>
            {resumeLabel}
          </button>
        )}
        <button className="btn-primary" onClick={onSubmit}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
