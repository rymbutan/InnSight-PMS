import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon';

// ─────────────────────────────────────────────────────────────────────────────
// On-screen notification pop-ups.
//
// The bell is a place you go and look. This is the half that comes to you: an
// event arrives, a card slides in over the corner of whatever page is open, and
// it leaves on its own. Same feed, same rows — NotificationBell and this share
// one useNotificationFeed in Layout, because each call to that hook opens its
// own SSE stream and two streams per tab would double the server's fan-out for
// the same events.
//
// WHY NOT THE EXISTING TOASTS
// ---------------------------
// components/Toast.jsx reports the outcome of something YOU just did — saved,
// failed, copied. These report something SOMEONE ELSE did. Mixing them would
// mean a colleague checking in a guest looks identical to your own save
// succeeding, and would put a message from housekeeping in the same queue as a
// validation error. Different source, different meaning, different component.
//
// WHY A CAP OF THREE
// ------------------
// A night audit or a bulk import can emit a dozen events in a second. Stacking
// all of them would paper over the screen with the thing the user is trying to
// work on. Three is enough to see a burst is happening; the rest are in the
// bell, which is where a backlog belongs.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_VISIBLE = 3;

// Long enough to read a two-line card without being long enough to accumulate.
const DISMISS_AFTER_MS = 6500;

export default function NotificationPopups({ items, onDismiss }) {
  const navigate = useNavigate();
  // Which cards the reader is hovering. A pop-up that vanishes mid-sentence
  // because the timer did not care that someone was reading it is worse than no
  // pop-up: they now know something happened and not what.
  const [held, setHeld] = useState(() => new Set());

  // ONE TIMER PER CARD, started when that card appears and never restarted.
  //
  // The obvious version — clear every timer and re-arm them whenever `items`
  // changes — is wrong in exactly the situation this component exists for. A
  // busy evening emits events continuously, each arrival re-arms every card
  // already on screen, and the stack stops expiring at all: the cards pile up
  // to the cap and sit there. Keyed timers mean a card's six and a half seconds
  // are its own, whatever arrives after it.
  const timers = useRef(new Map());

  useEffect(() => {
    const live = new Set(items.map((i) => i.id));

    // Gone (dismissed, or clicked through): drop its timer.
    for (const [id, handle] of timers.current) {
      if (!live.has(id)) {
        clearTimeout(handle);
        timers.current.delete(id);
      }
    }

    for (const item of items) {
      if (held.has(item.id)) {
        // Being read. Cancel the countdown; it restarts on mouse-leave, which is
        // the behaviour someone who pulls away mid-read expects.
        const handle = timers.current.get(item.id);
        if (handle) {
          clearTimeout(handle);
          timers.current.delete(item.id);
        }
        continue;
      }
      if (timers.current.has(item.id)) continue;
      timers.current.set(
        item.id,
        setTimeout(() => {
          timers.current.delete(item.id);
          onDismiss(item.id);
        }, DISMISS_AFTER_MS)
      );
    }
  }, [items, held, onDismiss]);

  // Unmounting (a sign-out, say) must not leave timers calling back into a
  // component that is gone.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const handle of map.values()) clearTimeout(handle);
      map.clear();
    };
  }, []);

  if (items.length === 0) return null;

  const visible = items.slice(0, MAX_VISIBLE);
  const hidden = items.length - visible.length;

  function open(item) {
    onDismiss(item.id);
    if (item.to) navigate(item.to);
  }

  return (
    <div className="notif-pop-stack" aria-live="polite" aria-atomic="false">
      {visible.map((item) => (
        <div
          key={item.id}
          className={`notif-popup${item.to ? ' is-clickable' : ''}`}
          onMouseEnter={() => setHeld((h) => new Set(h).add(item.id))}
          onMouseLeave={() =>
            setHeld((h) => {
              const next = new Set(h);
              next.delete(item.id);
              return next;
            })
          }
        >
          <span className="notif-popup-icon">
            <Icon name={item.icon || 'bell'} size={15} strokeWidth={1.9} />
          </span>
          {/* A div rather than a button wrapping everything, so the Dismiss
              control below is not a button inside a button. */}
          <div
            className="notif-popup-body"
            onClick={() => open(item)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open(item);
              }
            }}
            role={item.to ? 'link' : undefined}
            tabIndex={item.to ? 0 : undefined}
          >
            <div className="notif-popup-title">{item.text}</div>
            {item.subject ? <div className="notif-popup-sub">{item.subject}</div> : null}
          </div>
          <button
            type="button"
            className="notif-popup-x"
            onClick={() => onDismiss(item.id)}
            aria-label="Dismiss notification"
          >
            <Icon name="x" size={13} strokeWidth={2.2} />
          </button>
        </div>
      ))}
      {hidden > 0 && (
        <div className="notif-popup notif-popup-more">+{hidden} more — open the bell to see them</div>
      )}
    </div>
  );
}
