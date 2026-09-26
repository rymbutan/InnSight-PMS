import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LAYOUTS } from '../sim/roomLayouts';
import api from '../api';
import Icon from '../components/Icon';
import LayoutPlan from '../sim/LayoutPlan';
import { useToast } from '../components/Toast';
// Not lazy: it is one of two tabs on this page, so it is reached by a click
// with no route change and a Suspense flash on a tab switch would read as a
// stall. The heavy part — the scenario editor itself — is still lazy inside it.
import InspectionScenarios from './InspectionScenarios';

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
const BUILT_IN = TIERS.map((t) => t.name);
// Mirrors the server's own key check in layouts.routes.js. Validated here too so
// a bad name is refused before it costs a round trip.
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;

export default function RoomLayouts() {
  // Which tier is open lives in the URL, not in component state. As state it
  // was lost on every reload — and reloading is exactly what you do after
  // dropping a new .glb in, so the editor threw you out at the moment you most
  // wanted to stay. In the URL it survives refresh, Back, and being pasted to
  // someone else.
  //
  // `replace: true` on close so leaving the editor does not stack a history
  // entry per open/close; Back still returns to whatever page you came from.
  const [params, setParams] = useSearchParams();
  const requested = params.get('tier');
  // A layout being authored but not yet written to the server. Held here rather
  // than in the URL because it has no server row to come back to after a
  // reload — refreshing mid-authoring genuinely has nothing to restore.
  const [newLayout, setNewLayout] = useState(null);
  const [serverLayouts, setServerLayouts] = useState([]);
  const [roomTypes, setRoomTypes] = useState([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ source: 'type', typeCode: '', name: '', w: 5, l: 6 });
  const customTiers = useMemo(
    () =>
      serverLayouts
        .map((r) => r.roomTier)
        .filter((k) => !BUILT_IN.includes(k))
        .sort(),
    [serverLayouts]
  );
  // Plan geometry for a layout card, whichever kind it is. The committed tiers
  // keep w/l/spawn at the top level; a server row nests them under `room`, so
  // this is the one place that difference is reconciled.
  const planOf = (name) => {
    const row = serverLayouts.find((r) => r.roomTier === name);
    if (row) return row;
    const L = LAYOUTS[name];
    if (!L) return null;
    return {
      room: { w: L.w, l: L.l, spawn: L.spawn },
      furniture: L.furniture,
      walls: L.walls,
      stations: L.stations,
    };
  };
  const setEditing = (tier) => {
    const next = new URLSearchParams(params);
    if (tier) next.set('tier', tier);
    else next.delete('tier');
    setParams(next, { replace: !tier });
  };

  // Guarded against a hand-typed or stale value — an unknown tier would render
  // an editor with no layout behind it. Custom keys are admitted once the index
  // has loaded, so a bookmarked custom layout opens on its own data rather than
  // silently on Standard's.
  const editing =
    requested &&
    (BUILT_IN.includes(requested) || customTiers.includes(requested) || newLayout?.key === requested)
      ? requested
      : null;

  // Which tab, also in the URL and for the same reason. `replace: true` — a tab
  // is a view of one page, not a place you should have to press Back through.
  const view = params.get('view') === 'scenarios' ? 'scenarios' : 'rooms';
  const setView = (next) => {
    const p = new URLSearchParams(params);
    if (next === 'scenarios') p.set('view', 'scenarios');
    else p.delete('view');
    setParams(p, { replace: true });
  };

  // ── Layouts that exist beyond the four committed ones ─────────────────────
  // Read from the server rather than from LAYOUTS, because that is where a
  // custom layout lives — there is no entry in the code for one.

  const loadLayoutIndex = useCallback(async () => {
    try {
      const [layouts, types] = await Promise.all([
        api.get('/api/room-layouts'),
        api.get('/api/room-types').catch(() => ({ data: [] })),
      ]);
      // Keep the WHOLE row, not just the key: the picker draws a floor-plan
      // thumbnail per layout, and a custom layout has no entry in LAYOUTS to
      // read geometry from — the server row is the only copy of it.
      setServerLayouts(layouts.data || []);
      setRoomTypes(types.data || []);
    } catch {
      /* the built-ins still list — a failed index must not blank the page */
    }
  }, []);

  useEffect(() => {
    if (view === 'rooms' && !editing) loadLayoutIndex();
  }, [view, editing, loadLayoutIndex]);

  // Room types that have no layout yet. A type already served by one is not
  // offered again — that would be an edit, and editing is what the cards do.
  const typesWithoutLayout = roomTypes.filter(
    (t) => !BUILT_IN.includes(t.name) && !customTiers.includes(t.name)
  );

  const draftKey = (draft.source === 'type' ? draft.typeCode : draft.name).trim();

  async function createLayout(e) {
    e.preventDefault();
    const key = draftKey;
    if (!KEY_RE.test(key)) {
      toast.error('Use letters, numbers, spaces, hyphens or underscores (max 40).');
      return;
    }
    if (BUILT_IN.includes(key) || customTiers.includes(key)) {
      toast.error(`A layout named “${key}” already exists.`);
      return;
    }
    // Nothing is written here. The editor opens empty and the author presses
    // Save, which is what creates version 1 — see `isNew` in RoomLayoutEditor.
    setAdding(false);
    setNewLayout({ key, w: Number(draft.w) || 5, l: Number(draft.l) || 6 });
    setEditing(key);
  }

  const toast = useToast();

  return (
    <div>
      <div className="page-head">
        <div className="page-head-title">
          <h1>Room &amp; Scenario Editor</h1>
          {/* Two halves of one job, so they are tabs rather than two rail
              entries: Rooms authors the room as it SHOULD be, Scenarios authors
              a specific room as it should NOT be. The choice lives in the URL so
              a reload — and this page reloads a lot while authoring — comes back
              to the tab you were on. */}
          <div className="seg" role="tablist" aria-label="Editor">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'rooms'}
              className={view === 'rooms' ? 'is-on' : ''}
              onClick={() => setView('rooms')}
            >
              <Icon name="box" size={13} strokeWidth={2} />
              Rooms
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'scenarios'}
              className={view === 'scenarios' ? 'is-on' : ''}
              onClick={() => setView('scenarios')}
            >
              <Icon name="clipboard-check" size={13} strokeWidth={2} />
              Scenarios
            </button>
          </div>
        </div>
      </div>

      <div className="mobile-wide-notice">
        <Icon name="alert-circle" size={14} />
        <span>The 3D editor needs a mouse and a larger screen — it opens here, but is not built for a phone.</span>
      </div>

      {view === 'scenarios' ? (
        <InspectionScenarios showTitle={false} />
      ) : (
        <>
          <div className="panel">
            <div className="panel-head">
              <h3>Choose a layout to edit</h3>
              <button
                type="button"
                className="rt-add"
                style={{ marginLeft: 'auto' }}
                onClick={() => setAdding((v) => !v)}
                aria-expanded={adding}
                aria-label="Add a room layout"
                title="Add a room layout"
              >
                <Icon name={adding ? 'x' : 'plus'} size={15} strokeWidth={2.6} />
              </button>
            </div>

            {adding && (
              <form onSubmit={createLayout} className="new-layout">
                {/* Two ways in. A room type keys the layout to something the
                    property actually rents, so the sim serves it to those rooms;
                    a free name is for authoring a room that does not exist as a
                    type yet — useful, but it stays unused until a type matches
                    it, which the hint below says out loud. */}
                <div className="seg" role="tablist" aria-label="Name the layout from">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={draft.source === 'type'}
                    className={draft.source === 'type' ? 'is-on' : ''}
                    onClick={() => setDraft((d) => ({ ...d, source: 'type' }))}
                  >
                    From a room type
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={draft.source === 'name'}
                    className={draft.source === 'name' ? 'is-on' : ''}
                    onClick={() => setDraft((d) => ({ ...d, source: 'name' }))}
                  >
                    Custom name
                  </button>
                </div>

                {/* One line: type/name, width, length, then the submit hard
                    right. The fields were full-width rows stacked over a button
                    on its own line, which spent four rows of height on three
                    short values — a width is two characters. */}
                <div className="new-layout-row">
                  <div className="nl-name">
                    {draft.source === 'type' ? (
                      <>
                        <label>Room type</label>
                        <select
                          value={draft.typeCode}
                          onChange={(e) => setDraft((d) => ({ ...d, typeCode: e.target.value }))}
                        >
                          <option value="">—</option>
                          {typesWithoutLayout.map((t) => (
                            <option key={t.code} value={t.name}>
                              {t.name} ({t.code})
                            </option>
                          ))}
                        </select>
                      </>
                    ) : (
                      <>
                        <label>Layout name</label>
                        <input
                          value={draft.name}
                          placeholder="Cabana"
                          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                        />
                      </>
                    )}
                  </div>
                  <div className="nl-dim">
                    <label>Width (m)</label>
                    <input
                      type="number"
                      min="2"
                      max="30"
                      step="0.5"
                      value={draft.w}
                      onChange={(e) => setDraft((d) => ({ ...d, w: e.target.value }))}
                    />
                  </div>
                  <div className="nl-dim">
                    <label>Length (m)</label>
                    <input
                      type="number"
                      min="2"
                      max="30"
                      step="0.5"
                      value={draft.l}
                      onChange={(e) => setDraft((d) => ({ ...d, l: e.target.value }))}
                    />
                  </div>
                  <div className="nl-go">
                    <button className="btn-primary" disabled={!draftKey}>
                      Create and open editor
                    </button>
                  </div>
                </div>

                <p className="tr-launch-blurb" style={{ marginTop: 0, marginBottom: 0 }}>
                  {draft.source === 'type'
                    ? typesWithoutLayout.length === 0
                      ? 'Every room type already has a layout. Use a custom name to author an extra one.'
                      : 'The sim serves this layout to rooms of that type.'
                    : 'A custom name is only served once a room type matches it exactly — otherwise it stays an unused draft.'}{' '}
                  The editor opens empty; nothing is saved until you press <strong>Save layout</strong>, and
                  autosave starts after that.
                </p>
              </form>
            )}

            <div className="tr-launch-grid">
              {TIERS.map((t) => {
                const L = LAYOUTS[t.name];
                return (
                  <div key={t.name} className="tr-launch-card">
                    <div className="tr-launch-head">
                      <strong>{t.name}</strong>
                      {/* Accent green with its paired ink, not a hardcoded slate.
                      `--on-accent` rather than a literal white because dark
                      mode's accent is a PALE green — white on it measures under
                      2:1, so the token flips to near-black there and keeps the
                      badge readable in both themes. In light mode it is white,
                      which is what this reads as on screen. */}
                      <span
                        className="badge"
                        style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
                      >
                        {L.w}×{L.l}m
                      </span>
                    </div>
                    {/* The saved layout, drawn. The separate "save slots" panel
                        that used to carry these thumbnails is gone — a preview
                        belongs on the card you click to edit, not in a second
                        grid further down the page. */}
                    <div className="layout-thumb">
                      <LayoutPlan layout={planOf(t.name)} height={104} />
                    </div>
                    <p className="tr-launch-blurb">{t.blurb}</p>
                    <p className="tr-launch-assesses">
                      {L.furniture.length} fixtures · {L.stations.length} stations · {(L.walls || []).length}{' '}
                      interior walls
                    </p>
                    <div className="tr-launch-foot">
                      <button
                        className="small secondary"
                        style={{ marginLeft: 'auto' }}
                        onClick={() => setEditing(t.name)}
                      >
                        Edit layout
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Layouts authored on this property. No committed blurb or
                  fixture counts to read from LAYOUTS — everything about them
                  lives on the server. */}
              {customTiers.map((key) => (
                <div key={key} className="tr-launch-card">
                  <div className="tr-launch-head">
                    <strong>{key}</strong>
                    <span
                      className="badge"
                      style={{ background: 'var(--neutral-soft)', color: 'var(--on-neutral-soft)' }}
                    >
                      Custom
                    </span>
                  </div>
                  <div className="layout-thumb">
                    <LayoutPlan layout={planOf(key)} height={104} />
                  </div>
                  <p className="tr-launch-blurb">
                    Authored on this property.{' '}
                    {roomTypes.some((t) => t.name === key)
                      ? 'Served to rooms of the matching type.'
                      : 'No room type matches this name yet, so nothing is served it.'}
                  </p>
                  <div className="tr-launch-foot">
                    <button
                      className="small secondary"
                      style={{ marginLeft: 'auto' }}
                      onClick={() => setEditing(key)}
                    >
                      Edit layout
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

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
          <RoomLayoutEditor
            typeName={editing}
            isNew={newLayout?.key === editing}
            seed={newLayout?.key === editing ? newLayout : null}
            // "Save as" wrote a copy under a new key; follow it, so the editor
            // is pointed at the layout the author is now actually changing.
            onSavedAs={(key) => {
              setNewLayout(null);
              loadLayoutIndex();
              setEditing(key);
            }}
            onClose={() => {
              setEditing(null);
              setNewLayout(null);
              // The layout may have been created while the editor was open, so
              // re-read the index rather than assuming it was not.
              loadLayoutIndex();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
