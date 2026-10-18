import Icon from '../../components/Icon';
import { scenarioCounts } from './scenario';
import { STATUS } from './useSavedScenarios';

// ─────────────────────────────────────────────────────────────────────────────
// The saved-scenario library, rendered.
//
// ONE component for both places it appears — the editor's left panel and the
// Scenarios tab of the Room & Scenario Editor page. They showed the same rows
// through completely different markup before: a narrow list of icon buttons in
// the editor, a five-column table plus a separate "save slots" panel on the
// page. Two renderings of one collection drift, and they had: the table could
// not activate a scenario, and the editor list could not tell you a fault count.
//
// `wide` is the only difference between them, and it is layout only — the same
// entries, the same four actions, in a row rather than stacked.
// ─────────────────────────────────────────────────────────────────────────────

// The card grid, shaped like "Choose a layout to edit" on the Rooms tab: title
// with a badge, a line of description, a line of counts, actions on the foot.
// Same classes as that grid, so the two stay visually identical without either
// one owning a copy of the other's CSS.
function ScenarioGrid({ scenarios, loaded, editingId, onEdit, onActivate, onDisable, onDelete }) {
  if (!loaded) return <p className="muted se-note">Loading…</p>;
  if (scenarios.length === 0) {
    return (
      <p className="muted se-note">
        None yet. Tiers with no active scenario fall back to generated faults, so students are never blocked
        while you build the library.
      </p>
    );
  }
  return (
    <div className="tr-launch-grid se-card-grid">
      {scenarios.map((s) => {
        const open = editingId === s.id;
        const active = s.status === STATUS.ACTIVE;
        const { faults, decoys } = scenarioCounts(s);
        return (
          <div key={s.id} className="tr-launch-card">
            <div className="tr-launch-head">
              <strong>{s.name}</strong>
              {/* The tier badge takes the accent, like the layout cards' size
                  badge; the state rides beside it as its own pill so "which
                  tier" and "is it live" never have to share one colour. */}
              <span className="badge" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
                {s.roomTier}
              </span>
            </div>
            <p className="tr-launch-blurb">
              <span className={`se-status ${active ? 'is-active' : 'is-disabled'}`}>
                {active ? 'Active' : 'Disabled'}
              </span>{' '}
              {active ? 'Students inspecting this tier may be handed it.' : 'Not served to students.'}
              {open && ' Currently open in the editor.'}
            </p>
            <p className="tr-launch-assesses">
              {faults} faults ·{' '}
              {decoys === 0 ? (
                <span title="With no clean decoys, every clickable item is a fault — students learn to flag whatever highlights.">
                  0 decoys ⚠
                </span>
              ) : (
                `${decoys} decoys`
              )}
            </p>
            {/* All four actions in one group. Edit used to sit apart, filled
                green and pushed hard right, which made it read as the card's
                headline action rather than one of four things you can do to a
                scenario. Green borders say "put this in play", red says "take it
                out" — the colour carries the direction, so the buttons do not
                have to differ in weight to be told apart. */}
            <div className="tr-launch-foot se-card-foot">
              <button
                className="small secondary outline-success"
                disabled={active}
                onClick={() => onActivate(s)}
                title={active ? 'Already active' : `Show “${s.name}” to students`}
              >
                Activate
              </button>
              <button
                className="small secondary outline-danger"
                disabled={!active}
                onClick={() => onDisable(s)}
                title={active ? `Stop serving “${s.name}”` : 'Already disabled'}
              >
                Disable
              </button>
              <button
                className="small secondary"
                onClick={() => onEdit(s)}
                title={`Load “${s.name}” into the editor`}
              >
                Edit scenario
              </button>
              {/* Delete keeps the SOLID red fill. It is the one action here that
                  cannot be undone, so it is the one that should not look like
                  its neighbours. */}
              <button
                className="danger small"
                onClick={() => onDelete(s)}
                title={`Delete "${s.name}"`}
                aria-label={`Delete ${s.name}`}
              >
                <Icon name="trash" size={13} strokeWidth={1.9} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function SavedScenarioList({
  scenarios,
  loaded,
  editingId = null,
  onNew,
  onEdit,
  onActivate,
  onDisable,
  onDelete,
  wide = false,
  // The page puts "+ New Scenario" in its panel header instead, where the
  // "Open scenario editor" button used to be — two new-scenario controls a few
  // pixels apart is what this turns off.
  showNew = true,
  // Card grid rather than a stacked list, matching "Choose a layout to edit".
  grid = false,
}) {
  if (grid) {
    return (
      <ScenarioGrid
        scenarios={scenarios}
        loaded={loaded}
        editingId={editingId}
        onEdit={onEdit}
        onActivate={onActivate}
        onDisable={onDisable}
        onDelete={onDelete}
      />
    );
  }
  return (
    <div className={`se-list${wide ? ' se-list--wide' : ''}`}>
      {showNew && (
        // Above the list, not inside it: starting a new scenario is not one of
        // the saved ones, and putting it in the list would make an action look
        // like a record.
        <button className="se-new" onClick={onNew} title="Start a blank scenario">
          <Icon name="plus" size={14} strokeWidth={2.4} />
          New Scenario
        </button>
      )}

      {!loaded && <p className="muted se-note">Loading…</p>}
      {loaded && scenarios.length === 0 && (
        <p className="muted se-note">
          None yet. Tiers with no active scenario fall back to generated faults, so students are never blocked
          while you build the library.
        </p>
      )}

      {scenarios.map((s) => {
        const open = editingId === s.id;
        const active = s.status === STATUS.ACTIVE;
        const { faults, decoys } = scenarioCounts(s);
        return (
          <div key={s.id} className={`se-item${open ? ' se-item-open' : ''}`}>
            <div className="se-item-head">
              <span className="se-item-name" title={s.name}>
                {s.name}
              </span>
              {/* State as a word, not an on/off toggle. The old control showed
                  the CURRENT state on a button that would change it, so "On"
                  could be read either as what it is or as what pressing it
                  does. */}
              <span className={`se-status ${active ? 'is-active' : 'is-disabled'}`}>
                {active ? 'Active' : 'Disabled'}
              </span>
            </div>
            <div className="se-item-sub">
              {s.roomTier} · {faults} faults ·{' '}
              {/* Zero decoys means every clickable object is a fault, and
                  students learn to flag whatever highlights rather than to
                  inspect. Worth flagging on the row, not just in a tooltip. */}
              {decoys === 0 ? (
                <span title="With no clean decoys, every clickable item is a fault — students learn to flag whatever highlights.">
                  0 decoys ⚠
                </span>
              ) : (
                `${decoys} decoys`
              )}
              {open && ' · editing'}
            </div>
            <div className="se-item-actions">
              {/* Activate and Disable are separate, and the one already in
                  force is disabled rather than hidden — a control that
                  disappears makes the row jump as you read down the list. */}
              <button
                className="small secondary outline-success"
                disabled={active}
                onClick={() => onActivate(s)}
                title={active ? 'Already active' : `Show “${s.name}” to students`}
              >
                Activate
              </button>
              <button
                className="small secondary outline-danger"
                disabled={!active}
                onClick={() => onDisable(s)}
                title={active ? `Stop serving “${s.name}”` : 'Already disabled'}
              >
                Disable
              </button>
              <button
                className="small secondary"
                onClick={() => onEdit(s)}
                title={`Load “${s.name}” into the editor`}
              >
                Edit
              </button>
              {/* A trash icon, not a "✕" glyph: ✕ reads as "close/dismiss" and
                  this permanently deletes an authored scenario. */}
              <button
                className="danger small"
                onClick={() => onDelete(s)}
                title={`Delete "${s.name}"`}
                aria-label={`Delete ${s.name}`}
              >
                <Icon name="trash" size={13} strokeWidth={1.9} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
