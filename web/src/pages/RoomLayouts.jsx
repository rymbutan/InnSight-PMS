import { lazy, Suspense, useState } from 'react';
import { LAYOUTS } from '../sim/roomLayouts';

const RoomLayoutEditor = lazy(() => import('../sim/RoomLayoutEditor'));

// ─────────────────────────────────────────────────────────────────────────────
// Room Layouts — ADMIN ONLY.
//
// This replaces the old `/sim-demo` "Model demo harness", which was an unlisted
// page reachable by any authenticated user who happened to know the URL. Two
// problems with that: it was invisible to the admin who actually needed it, and it
// was reachable by a housekeeping trainee who didn't.
//
// It is now a real page in the app: role-gated at the route AND hidden from the nav
// for everyone except ADMIN. The harness's "play this tier" buttons are gone — the
// Training page owns launching activities now, so this page does one thing.
//
// The editor itself renders as a full-screen overlay, so this page is just the
// launcher plus the context an admin needs to use it safely.
// ─────────────────────────────────────────────────────────────────────────────

const TIERS = [
  { name: 'Standard', blurb: 'Entry tier. Bed, ensuite, minibar, media wall.' },
  { name: 'Deluxe', blurb: 'Adds a centre lounge and a reading nook.' },
  { name: 'Suite', blurb: 'Adds a powder bath, wet bar and a dining set.' },
  { name: 'Presidential', blurb: 'Corner suite — master bath, office, living zone.' },
];

export default function RoomLayouts() {
  const [editing, setEditing] = useState(null);

  return (
    <div>
      <h2>Room Layouts</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Edit the 3D floor plan used by the housekeeping training sim — furniture, interior walls, task
        stations and room dimensions. Changes autosave to the server and are{' '}
        <strong>live for every browser</strong> the moment you make them.
      </p>

      <div className="panel">
        <h3>Choose a tier to edit</h3>
        <div className="tr-launch-grid">
          {TIERS.map((t) => {
            const L = LAYOUTS[t.name];
            return (
              <div key={t.name} className="tr-launch-card">
                <div className="tr-launch-head">
                  <strong>{t.name}</strong>
                  <span className="badge" style={{ background: '#475569' }}>
                    {L.w}×{L.l}m
                  </span>
                </div>
                <p className="tr-launch-blurb">{t.blurb}</p>
                <p className="tr-launch-assesses">
                  {L.furniture.length} fixtures · {L.stations.length} stations · {(L.walls || []).length}{' '}
                  interior walls
                </p>
                <div className="tr-launch-foot">
                  <button
                    className="btn-primary"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => setEditing(t.name)}
                  >
                    ✏️ Edit layout
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <h3>Before you export</h3>
        <p className="tr-launch-blurb">
          The editor emits <strong>literal coordinates</strong>. The checked-in layouts compute them instead —{' '}
          <code>atBack(l, FP.bed[1])</code> puts a fixture&apos;s back face exactly on the wall using its
          rendered footprint, which is what keeps beds from floating and bathtubs from cutting into walls.
          Pasting a whole block replaces that with fixed numbers, so nothing re-derives when a model&apos;s
          size changes.
        </p>
        <p className="tr-launch-blurb">
          For small tweaks, read the values out of the Inspector and hand-edit the one line in{' '}
          <code>web/src/sim/roomLayouts.js</code>. Either way, always run the validator afterwards — it checks
          reachability <em>and</em> 3D geometry (ceiling clearance, wall clipping, collision boxes matching
          what renders):
        </p>
        <pre
          style={{
            background: 'var(--panel-2, rgba(0,0,0,0.25))',
            padding: '10px 12px',
            borderRadius: 8,
            fontSize: 12.5,
            overflowX: 'auto',
          }}
        >
          node scripts/check-room-layouts.mjs
        </pre>
        <p className="tr-launch-blurb">
          See <code>HOW-TO-OPEN-EDITOR.md</code> for the full workflow, including how to add a new{' '}
          <code>.glb</code>.
        </p>
      </div>

      {editing && (
        <Suspense
          fallback={
            <div className="cg-overlay">
              <div className="cg-window">
                <p style={{ padding: 24 }}>Loading the editor…</p>
              </div>
            </div>
          }
        >
          <RoomLayoutEditor typeName={editing} onClose={() => setEditing(null)} />
        </Suspense>
      )}
    </div>
  );
}
