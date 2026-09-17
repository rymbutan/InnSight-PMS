// "Marisol is typing…" — the three-dot bubble, shared by the docked chat window
// and the full Messages page.
//
// ONE component for both surfaces, for the same reason useMessaging.js is one
// data layer: two hand-rolled copies would drift, and this one has a detail that
// is easy to get wrong twice — the animation has to stop for anyone who has
// asked their system not to animate things.
//
// It renders at the BOTTOM of the transcript, in the flow, rather than as an
// overlay: an absolutely positioned indicator covers the last message, which is
// the one thing the reader is most likely to be reading when it appears.

export default function TypingIndicator({ name }) {
  // `role="status"` so a screen reader announces it once when it appears and is
  // not interrupted mid-sentence; `aria-live="polite"` is the default for status
  // but stated here because the whole point is that it must not be assertive.
  const who = name ? `${name} is typing` : 'Typing';
  return (
    <div className="typing-row" role="status" aria-live="polite" aria-label={`${who}…`}>
      <span className="typing-bubble">
        {/* aria-hidden: the dots are decoration, the label above is the message. */}
        <span className="typing-dot" aria-hidden="true" />
        <span className="typing-dot" aria-hidden="true" />
        <span className="typing-dot" aria-hidden="true" />
      </span>
      <span className="typing-label muted">{who}…</span>
    </div>
  );
}
