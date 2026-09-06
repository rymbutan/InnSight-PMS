import Icon from '../components/Icon';

// The autosave readout, shared by the room-layout editor and the scenario
// editor. Both autosave to the server and both need to say so in the same
// words — an author who learns "Saved" in one tool should not have to learn a
// different vocabulary in the other.
//
// `pending` is the state the scenario editor needs and the layout editor does
// not have a use for: a scenario cannot be autosaved until it has been created
// once, and silently showing "Autosave on" over a draft that is NOT being saved
// is the one message that would actively mislead.
const SAVE_UI = {
  idle: { icon: 'check-circle', label: 'Autosave on', title: 'Edits save automatically for everyone.' },
  pending: {
    icon: 'info',
    label: 'Not saved yet',
    title: 'Autosave starts once this has been saved for the first time.',
  },
  saving: { icon: 'refresh-cw', label: 'Saving…', title: 'Sending this to the server.' },
  saved: { icon: 'check-circle', label: 'Saved', title: 'Saved — live for every browser.' },
  error: { icon: 'alert-circle', label: 'Not saved', title: 'The last autosave failed.' },
};

export default function SaveChip({ state, error }) {
  const ui = SAVE_UI[state] || SAVE_UI.idle;
  return (
    <span
      className={`ed-save is-${state}`}
      // The failure REASON goes in the tooltip, not the chip. It can be a long
      // server message, and a toolbar that resizes itself when a save fails
      // would shove every tool sideways at the worst possible moment.
      title={state === 'error' && error ? `${ui.title} ${error}` : ui.title}
      role="status"
      aria-live="polite"
    >
      <Icon name={ui.icon} size={14} strokeWidth={2} />
      <span className="ed-save-label">{ui.label}</span>
    </span>
  );
}
