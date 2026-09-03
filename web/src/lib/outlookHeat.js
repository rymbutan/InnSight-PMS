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
  { upTo: 0, fill: 'var(--surface-2)', label: 'Empty' },
  { upTo: 0.25, fill: '#cde2fb', label: '1–24%' },
  { upTo: 0.5, fill: '#9ec5f4', label: '25–49%' },
  { upTo: 0.75, fill: '#5598e7', label: '50–74%' },
  { upTo: 0.999, fill: '#2a78d6', label: '75–99%' },
  { upTo: Infinity, fill: '#184f95', label: 'Sold out' },
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
 * Ink for a cell. Only the top two steps are dark enough to need light text —
 * hardcoded rather than computed because `var(--surface-2)` is not a hex and
 * cannot be measured, and the four light steps all take the same dark ink.
 */
export function heatInk(occ) {
  const fill = heatFill(occ);
  return fill === '#2a78d6' || fill === '#184f95' ? '#ffffff' : 'var(--text)';
}

/** Plain-language summary for the cell's tooltip. */
export function heatTitle(typeName, date, available, total) {
  const sold = Math.max(0, (Number(total) || 0) - (Number(available) || 0));
  const pct = Math.round(occupancyOf(available, total) * 100);
  const when = date instanceof Date ? date.toLocaleDateString() : String(date);
  return `${typeName} · ${when}\n${available} of ${total} left · ${sold} sold (${pct}% full)`;
}
