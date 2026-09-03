// Shared outcome vocabulary and formatting for the training sim.
//
// WHY THIS IS A SEPARATE, REACT-FREE MODULE
// -----------------------------------------
// `Assessment.jsx` renders a Did/Why rubric, and the inspection case study
// (sim/inspection) computes one. Both need the same three outcome values, and
// the scoring rules must be unit-testable without mounting React — `node --test`
// cannot import a .jsx file, so anything a test needs to reach lives here.
//
// HISTORY
// -------
// This module used to be the scoring spine for thirteen mini-game stations: a
// slip budget, a par time, AABB drop-zone hit tests and a vacuum coverage grid.
// Those activities were removed when the 3D simulation became an inspection
// case study (see docs/superpowers/specs/2026-08-18-3d-inspection-case-study-design.md),
// and their helpers went with them rather than being left as unreachable code
// with tests that made the suite look better covered than it was. Grading now
// lives in sim/inspection/inspectionScore.js, which is scored on found/missed
// defects and inspection precision rather than on slips against a clock.

export const GOOD = 'good';
export const ISSUES = 'issues';
export const SKIPPED = 'skipped';

/** "95s" / "2m 05s" — used by the assessment table and the shift clock. */
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
