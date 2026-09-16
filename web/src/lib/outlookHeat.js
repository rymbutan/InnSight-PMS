// ─────────────────────────────────────────────────────────────────────────────
// Reading the 14-day outlook at a glance.
//
// The outlook was a 4×14 grid of bare availability numbers. Every figure was
// correct and the grid told you almost nothing: to find the week's pressure you
// had to read fifty-six numbers and hold them in your head, and "24" means
// something completely different for a Standard with 24 rooms than for a
// Presidential with 3.
//
// So the cell keeps the number — that is what a front-desk user acts on — and
// gains a colour for how FULL that type is on that day. Occupancy normalises
// across types, which the raw count cannot: 3 of 3 Presidential suites sold and
// 24 of 24 Standards sold are both "no more to sell", and now both read that way.
//
// SEQUENTIAL, so one hue light→dark. Steps are the validated blue ramp from the
// data-viz reference; a rainbow across a magnitude is the classic way to make a
// heatmap look informative and be unreadable.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Occupancy bucket → fill. Six steps, not a continuous gradient: a reader
 * comparing two cells is matching them against the legend, and the eye cannot
 * place a continuous shade on a scale but can match a swatch.
 */
const STEPS = [
  { upTo: 0, fill: 'var(--heat-0)', ink: 'var(--heat-0-ink)', label: 'Empty' },
  { upTo: 0.25, fill: 'var(--heat-1)', ink: 'var(--heat-1-ink)', label: '1–24%' },
  { upTo: 0.5, fill: 'var(--heat-2)', ink: 'var(--heat-2-ink)', label: '25–49%' },
  { upTo: 0.75, fill: 'var(--heat-3)', ink: 'var(--heat-3-ink)', label: '50–74%' },
  { upTo: 0.999, fill: 'var(--heat-4)', ink: 'var(--heat-4-ink)', label: '75–99%' },
  { upTo: Infinity, fill: 'var(--heat-5)', ink: 'var(--heat-5-ink)', label: 'Sold out' },
];

/** The legend, in the order a reader scans it. */
export const HEAT_LEGEND = STEPS.map((s) => ({ fill: s.fill, label: s.label }));

/**
 * How full a room type is on a day, 0..1.
 * A type with no inventory is not "full", it is not sellable — 0 keeps it pale
 * rather than painting it as sold out.
 */
export function occupancyOf(available, total) {
  const t = Number(total) || 0;
  if (t <= 0) return 0;
  const a = Math.max(0, Math.min(t, Number(available) || 0));
  return (t - a) / t;
}

/** The cell fill for an occupancy fraction. */
export function heatFill(occ) {
  const v = Number.isFinite(occ) ? Math.max(0, occ) : 0;
  for (const s of STEPS) if (v <= s.upTo) return s.fill;
  return STEPS[STEPS.length - 1].fill;
}

/**
 * Ink for a cell.
 *
 * Each step now carries its own ink token rather than this function deciding by
 * matching the fill against two hard-coded hexes. That test could only ever
 * describe ONE ramp: the light steps fell through to `var(--text)`, which is
 * near-white under data-theme="dark", so in dark mode the pale-blue cells were
 * white-on-pale-blue. Ink belongs beside the fill it sits on, and both flip with
 * the theme — see the --heat-* tokens in styles.css.
 */
export function heatInk(occ) {
  const v = Number.isFinite(occ) ? Math.max(0, occ) : 0;
  for (const s of STEPS) if (v <= s.upTo) return s.ink;
  return STEPS[STEPS.length - 1].ink;
}

/** Plain-language summary for the cell's tooltip. */
export function heatTitle(typeName, date, available, total) {
  const sold = Math.max(0, (Number(total) || 0) - (Number(available) || 0));
  const pct = Math.round(occupancyOf(available, total) * 100);
  const when = date instanceof Date ? date.toLocaleDateString() : String(date);
  return `${typeName} · ${when}\n${available} of ${total} left · ${sold} sold (${pct}% full)`;
}

/**
 * The panel's headline occupancy and its per-day series, over the SAME cells
 * the grid renders.
 *
 * It lives here rather than in Dashboard.jsx because it is arithmetic, and the
 * arithmetic is what was wrong: the panel used to show today's in-house count
 * under a "14-DAY OCCUPANCY" label and graph up to 400 days of night-audit
 * history beside a fourteen-day table. Three numbers, three different
 * questions. One function, next to `occupancyOf` whose convention it follows,
 * so the headline and the graph are derived from the grid and tested with it.
 *
 * @param {{types: Array, days: Date[], cells: Object}} outlook
 * @param {(d: Date) => string} dayKey  how a Date becomes a `cells` key
 * @returns {{pct: number, series: number[]}} percentages, 0..100
 */
export function outlookOccupancy(outlook, dayKey) {
  const types = outlook?.types || [];
  const days = outlook?.days || [];
  const cells = outlook?.cells || {};
  const capacity = types.reduce((s, t) => s + (Number(t.totalInventory) || 0), 0);
  if (capacity <= 0 || days.length === 0) return { pct: 0, series: [] };

  const series = days.map((d) => {
    const ds = dayKey(d);
    // Unsold rooms across every type on this date. A MISSING cell counts as
    // fully available, not as zero: treating "the outlook has no figure for
    // this type/day" as nothing-left-to-sell would invent a full house out of
    // an incomplete payload, and a dashboard that overstates occupancy is the
    // one error here nobody would question.
    const avail = types.reduce((s, t) => {
      const total = Number(t.totalInventory) || 0;
      const c = cells[`${t.code}|${ds}`];
      const a = c === undefined || c === null ? total : Number(c) || 0;
      return s + Math.max(0, Math.min(total, a));
    }, 0);
    return ((capacity - avail) / capacity) * 100;
  });

  // Occupancy over a period is room-nights sold / room-nights available. With
  // capacity constant across the fortnight that reduces to the mean of the
  // daily rates — which is what this is, and why it is not a sum.
  return { pct: series.reduce((a, b) => a + b, 0) / series.length, series };
}
