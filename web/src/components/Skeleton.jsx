// Tiny skeleton primitives. Replace boring spinners with shimmer placeholders
// that match the shape of the content being loaded.
//
//   <Skeleton width="80%" height={20} />
//   <SkeletonRow cols={5} />
//   <SkeletonTable rows={6} cols={4} />

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
