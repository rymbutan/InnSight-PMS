import { lazy, Suspense, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import Icon from '../components/Icon';
import { useSavedScenarios, STATUS } from '../sim/inspection/useSavedScenarios';
import SavedScenarioList from '../sim/inspection/SavedScenarioList';

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

// `showTitle` is false when this renders as the Scenarios tab of the Room &
// Scenario Editor — the host page already carries the <h1> and the switcher, and
// a second heading under it would read as a nested page. The standalone route
// (/inspection-scenarios, still live for bookmarks) keeps its own title.
export default function InspectionScenarios({ showTitle = true }) {
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
  const toast = useToast();
  const confirm = useConfirm();
  // The library and every non-authoring action on it. Same hook the editor
  // uses, so this page and the editor's own list cannot disagree about what is
  // saved or what state it is in.
  const onListError = useCallback((m) => toast.error(m), [toast]);
  const onListSuccess = useCallback((m) => toast.success(m), [toast]);
  const { savedScenarios, loaded, reload, setStatus, remove } = useSavedScenarios({
    onError: onListError,
    onSuccess: onListSuccess,
    confirm,
  });

  // Re-read when the editor closes: it may have created, renamed or deleted a
  // scenario while it was open.
  useEffect(() => {
    if (!open) reload();
  }, [open, reload]);

  return (
    <div>
      {showTitle && (
        <div className="page-head">
          <div className="page-head-title">
            <h1>Inspection Scenarios (3D)</h1>
          </div>
        </div>
      )}
      <p className="muted" style={{ marginTop: 0 }}>
        Author what is <strong>wrong</strong> with a room. Place things where they should not be, tag each one
        with the kind of fault it is, and set the booking the room is wrong for. Students inspecting that tier
        get one of your active scenarios; tiers with none fall back to generated faults, so nothing breaks
        while you build a library.
      </p>

      <div className="panel">
        <div className="panel-head">
          <h3>Your scenarios</h3>
          {/* This was "Open scenario editor". Opening the editor with nothing
              loaded IS starting a new scenario, so the button now says what it
              does — and the separate "+ New Scenario" inside the list is gone
              rather than sitting a few pixels below saying the same thing. */}
          <button className="btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setOpen(true)}>
            <Icon name="plus" size={14} strokeWidth={2.4} />
            New Scenario
          </button>
        </div>
        {/* Card grid, matching "Choose a layout to edit" on the Rooms tab —
            same component the editor's side panel uses, just laid out as cards
            rather than a narrow stacked list. */}
        <SavedScenarioList
          grid
          showNew={false}
          scenarios={savedScenarios}
          loaded={loaded}
          onNew={() => setOpen(true)}
          onEdit={(s) => setOpen(true, s.id)}
          onActivate={(s) => setStatus(s, STATUS.ACTIVE)}
          onDisable={(s) => setStatus(s, STATUS.DISABLED)}
          onDelete={remove}
        />
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
