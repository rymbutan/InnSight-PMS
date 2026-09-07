import { lazy, Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import { useToast, errMsg } from '../components/Toast';
import EmptyState from '../components/EmptyState';

const ScenarioEditor = lazy(() => import('../sim/inspection/ScenarioEditor'));

// ─────────────────────────────────────────────────────────────────────────────
// Inspection Scenarios — ADMIN ONLY.
//
// Room Layouts authors the room as it SHOULD be. This authors a specific room as
// it should NOT be: a sofa across the bathroom door, a vacuum left mid-floor,
// two towels for a family of four — plus the booking those faults are wrong
// FOR, since half the six categories are only faults relative to the booking.
//
// Scenarios are stored server-side (unlike the localStorage room-layout drafts),
// because the whole point is that what an instructor authors is what every
// student inspects, on any machine.
// ─────────────────────────────────────────────────────────────────────────────

export default function InspectionScenarios() {
  // Whether the editor is open lives in the URL, not in component state. As
  // state it was lost on every reload — and this editor does not autosave, so
  // refreshing while authoring dropped you back to the launcher with the
  // scenario gone. In the URL it survives refresh and Back.
  //
  // `?scenario=<id>` carries WHICH saved scenario was open, so a reload comes
  // back to the same one rather than to an empty editor. Unsaved changes are
  // still lost — a refresh discards the page — but a saved scenario reopens
  // where you left it.
  const [params, setParams] = useSearchParams();
  const open = params.get('editor') === 'scenarios';
  const openScenarioId = params.get('scenario') || null;
  // `replace` on close so opening and shutting the editor does not stack a
  // history entry per visit; Back still leaves the page.
  const setOpen = (next, scenarioId) => {
    const p = new URLSearchParams(params);
    if (next) {
      p.set('editor', 'scenarios');
      if (scenarioId) p.set('scenario', scenarioId);
      else p.delete('scenario');
    } else {
      p.delete('editor');
      p.delete('scenario');
    }
    setParams(p, { replace: !next });
  };
  const [scenarios, setScenarios] = useState([]);
  const toast = useToast();

  async function load() {
    try {
      const { data } = await api.get('/api/training/scenarios');
      setScenarios(data || []);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }
  useEffect(() => {
    load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const byTier = scenarios.reduce((acc, s) => {
    (acc[s.roomTier] = acc[s.roomTier] || []).push(s);
    return acc;
  }, {});

  return (
    <div>
      <h2>Inspection Scenarios (3D)</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Author what is <strong>wrong</strong> with a room. Place things where they should not be, tag each one
        with the kind of fault it is, and set the booking the room is wrong for. Students inspecting that tier
        get one of your active scenarios; tiers with none fall back to generated faults, so nothing breaks
        while you build a library.
      </p>

      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>Your scenarios</h3>
          <button className="btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setOpen(true)}>
            Open scenario editor
          </button>
        </div>

        {scenarios.length === 0 ? (
          <EmptyState
            kind="inbox"
            title="No scenarios authored yet"
            hint="Open the editor to build one. Until then, students get procedurally generated faults."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Tier</th>
                <th>Scenario</th>
                <th className="t-c">Faults</th>
                <th className="t-c">Decoys</th>
                <th className="t-c">Shown to students</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(byTier)
                .sort()
                .flatMap((t) =>
                  byTier[t].map((s) => {
                    const anchors = Array.isArray(s.anchors) ? s.anchors : [];
                    const faults = anchors.filter((a) => a.defectId).length;
                    const decoys = anchors.length - faults;
                    return (
                      <tr key={s.id} style={{ opacity: s.active ? 1 : 0.55 }}>
                        <td>{t}</td>
                        <td>{s.name}</td>
                        <td className="t-c">{faults}</td>
                        <td className="t-c">
                          {decoys === 0 ? (
                            <span title="With no clean decoys, every clickable item is a fault — students learn to flag whatever highlights.">
                              0 ⚠️
                            </span>
                          ) : (
                            decoys
                          )}
                        </td>
                        <td className="t-c">{s.active ? 'Yes' : 'No'}</td>
                      </tr>
                    );
                  })
                )}
            </tbody>
          </table>
        )}
      </div>

      {open && (
        <Suspense
          fallback={
            <div className="cg-overlay">
              <div className="cg-window">
                <p style={{ padding: 24 }}>Loading editor…</p>
              </div>
            </div>
          }
        >
          <ScenarioEditor
            onClose={() => setOpen(false)}
            // Which scenario to reopen after a reload, and the callback that
            // keeps the URL in step as you open or create one inside the
            // editor — so the address bar always describes what is on screen.
            initialScenarioId={openScenarioId}
            onScenarioChange={(id) => setOpen(true, id)}
          />
        </Suspense>
      )}
    </div>
  );
}
