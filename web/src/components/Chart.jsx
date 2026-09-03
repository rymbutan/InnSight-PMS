// Tiny dependency-free SVG charts. Keep them readable at small sizes.

export function SparkLine({ data, width = 260, height = 60, color = 'var(--accent)', label }) {
  if (!data || data.length < 2) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        {label || 'No data'}
      </div>
    );
  }
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * (height - 8) - 4).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {data.map((v, i) => (
        <circle
          key={i}
          cx={i * step}
          cy={height - ((v - min) / range) * (height - 8) - 4}
          r="2"
          fill={color}
        />
      ))}
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
              <text
                x={x + w / 2}
                y={height + 14}
                fontSize="10"
                textAnchor="middle"
                fill="var(--muted)"
              >
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
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={thickness} />
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
