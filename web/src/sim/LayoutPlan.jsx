// A saved layout, drawn as a top-down floor plan in plain SVG.
//
// WHY NOT 3D
// ----------
// The obvious thing for a "preview of the room" is a little 3D view, and it is
// the one thing that cannot be done here: only ONE <Canvas> may be mounted at a
// time (two WebGL contexts produce "Context Lost" — see README and
// sim/task3d.jsx). A slot list renders up to fifty cards at once, so fifty live
// contexts is not a heavy version of this idea, it is a broken one.
//
// A plan view is also the more useful drawing for the job the list does. You
// open the slot list to answer "which version was the one before I moved the
// beds", and a top-down plan shows fixture positions at a glance where a
// perspective render hides half of them behind each other.
//
// Purely presentational: it takes the geometry it is handed and never fetches,
// so it works for a live layout and an old version alike.

// Fixture footprints are not stored per fixture — the editor keeps positions and
// the renderer looks the size up by model key. Rather than import the whole
// sizing table (and its .glb coupling) into a thumbnail, everything is drawn at
// one small square. The plan communicates WHERE things are and how many; exact
// footprints are the editor's job.
const FIXTURE_R = 0.28; // metres, half-width of the square drawn per fixture

export default function LayoutPlan({ layout, height = 132 }) {
  const room = layout?.room;
  // A version saved before a field existed, or a malformed row, must not take
  // the whole slot list down with it — draw nothing and let the card's text
  // still say what the version is.
  if (!room || !Number.isFinite(room.w) || !Number.isFinite(room.l)) return null;

  const { w, l } = room;
  const furniture = Array.isArray(layout.furniture) ? layout.furniture : [];
  const walls = Array.isArray(layout.walls) ? layout.walls : [];
  const stations = Array.isArray(layout.stations) ? layout.stations : [];

  // The editor's coordinate origin is the room's CENTRE, so x and z run from
  // -w/2..+w/2. Shift into SVG space, where the origin is the top-left corner.
  const PAD = 0.35;
  const vb = `${-PAD} ${-PAD} ${w + PAD * 2} ${l + PAD * 2}`;
  const tx = (x) => x + w / 2;
  const tz = (z) => z + l / 2;

  const pos = (f) => (Array.isArray(f?.pos) && f.pos.length === 2 ? f.pos : null);

  return (
    <svg
      className="plan-svg"
      viewBox={vb}
      style={{ height }}
      role="img"
      aria-label={`Floor plan: ${w}×${l} metres, ${furniture.length} fixtures`}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Floor */}
      <rect
        x="0"
        y="0"
        width={w}
        height={l}
        rx="0.15"
        fill="var(--plan-floor)"
        stroke="var(--plan-wall)"
        strokeWidth="0.09"
      />

      {/* Interior walls. A wall is a segment with a thickness; stored either as
          {x1,z1,x2,z2} or as a centre plus a size, so both are handled rather
          than assuming whichever one this property happens to have saved. */}
      {walls.map((wall, i) => {
        if (Number.isFinite(wall?.x1) && Number.isFinite(wall?.z1)) {
          return (
            <line
              key={`w${i}`}
              x1={tx(wall.x1)}
              y1={tz(wall.z1)}
              x2={tx(wall.x2)}
              y2={tz(wall.z2)}
              stroke="var(--plan-wall)"
              strokeWidth="0.14"
              strokeLinecap="round"
            />
          );
        }
        const p = pos(wall);
        if (!p) return null;
        const ww = Number.isFinite(wall.w) ? wall.w : 1;
        const wl = Number.isFinite(wall.l) ? wall.l : 0.16;
        return (
          <rect
            key={`w${i}`}
            x={tx(p[0]) - ww / 2}
            y={tz(p[1]) - wl / 2}
            width={ww}
            height={wl}
            fill="var(--plan-wall)"
          />
        );
      })}

      {/* Fixtures */}
      {furniture.map((f, i) => {
        const p = pos(f);
        if (!p) return null;
        return (
          <rect
            key={`f${i}`}
            x={tx(p[0]) - FIXTURE_R}
            y={tz(p[1]) - FIXTURE_R}
            width={FIXTURE_R * 2}
            height={FIXTURE_R * 2}
            rx="0.07"
            fill="var(--plan-fixture)"
          />
        );
      })}

      {/* Task stations — the marks a trainee actually walks to, so they read as
          accents rather than as more furniture. */}
      {stations.map((s, i) => {
        const p = pos(s);
        if (!p) return null;
        return (
          <circle key={`s${i}`} cx={tx(p[0])} cy={tz(p[1])} r={FIXTURE_R * 0.62} fill="var(--plan-station)" />
        );
      })}

      {/* Spawn: where the student enters. Drawn last so nothing covers it. */}
      {Array.isArray(room.spawn) && room.spawn.length === 2 && (
        <circle
          cx={tx(room.spawn[0])}
          cy={tz(room.spawn[1])}
          r={FIXTURE_R * 0.75}
          fill="none"
          stroke="var(--plan-spawn)"
          strokeWidth="0.1"
        />
      )}
    </svg>
  );
}
