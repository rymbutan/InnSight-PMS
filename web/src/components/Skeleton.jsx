// Tiny skeleton primitives. Replace boring spinners with shimmer placeholders
// that match the shape of the content being loaded.
//
//   <Skeleton width="80%" height={20} />
//   <SkeletonRow cols={5} />
//   <SkeletonTable rows={6} cols={4} />
//   <SkeletonRows rows={4} cols={5} />   just the <tr>s, for an existing <tbody>
//   <SkeletonTableBlock rows={8} cols={6} />  the same, with a header row
//   <SkeletonList rows={6} />        avatar + two lines, for contact/people lists
//   <SkeletonPanel lines={5} />      a heading and a few paragraphs of text
//
// Every wrapper announces itself as busy ("Loading") to screen readers, since
// the shimmer itself is aria-hidden.

export function Skeleton({ width = '100%', height = 14, radius = 4, style }) {
  return (
    <span
      className="skel"
      style={{
        display: 'inline-block',
        width,
        height,
        borderRadius: radius,
        ...style,
      }}
      aria-hidden="true"
    />
  );
}

export function SkeletonRow({ cols = 4 }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i}>
          <Skeleton width={`${50 + Math.random() * 40}%`} />
        </td>
      ))}
    </tr>
  );
}

// Several placeholder rows for a <tbody> that is still waiting on its data.
export function SkeletonRows({ rows = 4, cols = 4 }) {
  return Array.from({ length: rows }).map((_, i) => <SkeletonRow key={i} cols={cols} />);
}

export function SkeletonTable({ rows = 5, cols = 4 }) {
  return (
    <table>
      <tbody>
        {Array.from({ length: rows }).map((_, i) => (
          <SkeletonRow key={i} cols={cols} />
        ))}
      </tbody>
    </table>
  );
}

export function SkeletonKPI() {
  return (
    <div className="kpi-tile">
      <div>
        <Skeleton width={80} height={32} style={{ marginBottom: 8 }} />
        <Skeleton width={120} height={12} />
      </div>
    </div>
  );
}

const SR_ONLY = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};

function Busy({ label = 'Loading', children, style, className }) {
  return (
    <div role="status" aria-busy="true" className={className} style={style}>
      <span style={SR_ONLY}>{label}</span>
      {children}
    </div>
  );
}

// A table-shaped placeholder with a header row, for lists that load into a table.
export function SkeletonTableBlock({ rows = 8, cols = 6, label }) {
  return (
    <Busy label={label} style={{ overflow: 'hidden' }}>
      <table>
        <thead>
          <tr>
            {Array.from({ length: cols }).map((_, i) => (
              <th key={i}>
                <Skeleton width="60%" height={11} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <SkeletonRow key={i} cols={cols} />
          ))}
        </tbody>
      </table>
    </Busy>
  );
}

// Avatar + two lines per row — the shape of a contact list.
export function SkeletonList({ rows = 6, label }) {
  return (
    <Busy label={label} style={{ display: 'grid', gap: 14, padding: '14px 12px' }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Skeleton width={34} height={34} radius={17} style={{ flex: 'none' }} />
          <div style={{ flex: 1, display: 'grid', gap: 6 }}>
            <Skeleton width={`${45 + ((i * 17) % 35)}%`} height={12} />
            <Skeleton width={`${25 + ((i * 23) % 30)}%`} height={10} />
          </div>
        </div>
      ))}
    </Busy>
  );
}

// A heading and a few lines of text — the shape of a detail panel or card.
export function SkeletonPanel({ lines = 4, label }) {
  return (
    <Busy label={label} style={{ display: 'grid', gap: 10, padding: '6px 0' }}>
      <Skeleton width="35%" height={18} />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={`${95 - ((i * 13) % 40)}%`} height={12} />
      ))}
    </Busy>
  );
}
