// Tiny dependency-free SVG charts. Keep them readable at small sizes.

export function SparkLine({
  data,
  width = 260,
  height = 60,
  color = 'var(--accent)',
  label,
  /** Pin the vertical scale instead of letting the data set it. A percentage
   *  series should be read against 0–100: left to auto-scale, a fortnight
   *  wobbling between 2% and 4% fills the full height and reads as a crisis.
   *  Auto-scaling is still the default, because for a currency series there is
   *  no natural ceiling to pin it to. */
  min: domainMin,
  max: domainMax,
  /** Draw the area under the line. Cheap way to make a 36px-tall spark read as
   *  a trend rather than as a squiggle. */
  fill = false,
}) {
  if (!data || data.length < 2) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        {label || 'No data'}
      </div>
    );
  }
  // The stroke is 2px wide and is CENTRED on the path, so a point sitting
  // exactly on an edge of the viewBox loses its outer half to clipping. Every
  // extreme of the series — the peaks and troughs, the parts being looked at —
  // was shaved flat on the top and bottom, and the first and last points were
  // sliced vertically down the middle. Inset by half the stroke plus a hair.
  const PAD = 2;
  const max = domainMax ?? Math.max(...data);
  const min = domainMin ?? Math.min(...data);
  const range = max - min || 1;
  const plotW = Math.max(1, width - PAD * 2);
  const plotH = Math.max(1, height - PAD * 2);
  const step = plotW / (data.length - 1);
  const x = (i) => PAD + i * step;
  const y = (v) => PAD + plotH - ((Math.min(Math.max(v, min), max) - min) / range) * plotH;
  const points = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  // A dot on every reading is information while the readings are far enough
  // apart to tell apart. Past that the dots merge into a furry band along the
  // line and the chart looks broken — so they are drawn only when each one has
  // room to be its own mark.
  const showDots = step >= 8;
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {fill && (
        <polygon
          points={`${x(0).toFixed(1)},${(height - PAD).toFixed(1)} ${points} ${x(data.length - 1).toFixed(1)},${(
            height - PAD
          ).toFixed(1)}`}
          fill={color}
          opacity="0.13"
        />
      )}
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {showDots &&
        data.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="2" fill={color} />)}
    </svg>
  );
}

export function BarChart({
  data,
  width = 320,
  height = 120,
  color = 'var(--accent)',
  labels,
  format = (v) => v,
  /** Print the value above each bar. Off by default — a number on every mark is
   *  noise; switch it on for a short series where the exact figure matters. */
  showValues = false,
  /** Marks at zero still get a sliver, so an empty day reads as "nothing here"
   *  rather than as a gap in the chart. */
  emptyColor = 'var(--border)',
}) {
  if (!data || !data.length)
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        No data
      </div>
    );
  const max = Math.max(...data, 1);
  const plotH = height - (showValues ? 16 : 8);
  const barW = (width - 8) / data.length;
  const gap = Math.min(6, barW * 0.25);
  const w = Math.max(1, barW - gap);
  // 4px rounded data-end, anchored square to the baseline. A plain `rx` rounds
  // all four corners and lifts the bar off its own axis, which is the detail
  // that makes a bar chart look like a row of pills.
  const r = Math.min(4, w / 2);

  return (
    <svg width={width} height={height + 24} style={{ display: 'block' }} role="img">
      {/* Baseline. Recessive: it orients the eye, it is not data. */}
      <line x1={0} y1={height} x2={width} y2={height} stroke="var(--border)" strokeWidth="1" />
      {data.map((v, i) => {
        const h = v > 0 ? Math.max(r, (v / max) * plotH) : 2;
        const x = i * barW + gap / 2;
        const y = height - h;
        const rr = Math.min(r, h);
        return (
          <g key={i} className="chart-bar">
            <path
              d={`M${x},${height} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${height} Z`}
              fill={v > 0 ? color : emptyColor}
            >
              <title>{labels ? `${labels[i]}: ${format(v)}` : format(v)}</title>
            </path>
            {showValues && v > 0 && (
              <text
                x={x + w / 2}
                y={y - 4}
                fontSize="10"
                fontWeight="600"
                textAnchor="middle"
                fill="var(--muted)"
              >
                {format(v)}
              </text>
            )}
            {labels && (
              <text x={x + w / 2} y={height + 14} fontSize="10" textAnchor="middle" fill="var(--muted)">
                {labels[i]}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function DonutChart({ segments, size = 120, thickness = 18 }) {
  // segments: [{ label, value, color }]
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--neutral-soft)"
          strokeWidth={thickness}
        />
        {segments.map((s, i) => {
          const len = (s.value / total) * c;
          const el = (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={thickness}
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            >
              <title>{`${s.label}: ${s.value}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      </svg>
      <div style={{ fontSize: 12 }}>
        {segments.map((s) => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span
              style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: 'inline-block' }}
            />
            <span>{s.label}</span>
            <span className="muted" style={{ marginLeft: 'auto' }}>
              {s.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
