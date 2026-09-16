import { clockTime, dayLabel } from '../lib/messageGroups';

/**
 * A grouped conversation, rendered from what lib/messageGroups.js builds.
 *
 * Its own file because BOTH surfaces draw it: the full-screen Messages page and
 * the docked chat windows. Two views of one conversation disagreeing about
 * where a day starts or what one person's turn looks like is the kind of
 * difference people notice and cannot explain, so there is one renderer.
 *
 * No avatar gutter, deliberately: in a two-person conversation the only thing a
 * repeated avatar tells you is which side the bubble is already on. How wide a
 * bubble may grow IS different between a 328px window and a full-width pane,
 * and that is CSS's business — `.chat-scroll` vs `.msg-scroll` in styles.css —
 * not a prop this component has to be told.
 */
export default function Transcript({ rows }) {
  // Re-derived each render rather than captured once, so a thread left open
  // across midnight relabels "Today" instead of insisting it still is.
  const now = new Date();
  return (
    <>
      {rows.map((row) =>
        row.type === 'day' ? (
          <div className="chat-day" key={row.key}>
            <span>{dayLabel(row.iso, now)}</span>
          </div>
        ) : (
          <div className={`chat-group${row.mine ? ' mine' : ''}`} key={row.key}>
            <div className="chat-group-bubbles">
              {row.items.map((m) => (
                <div className="chat-bubble" key={m.id}>
                  <span className="chat-bubble-body">{m.body}</span>
                </div>
              ))}
              {/* One timestamp per turn, under its final bubble. A stamp on
                  every line of a burst sent seconds apart is the noise that
                  made one person talking look like several separate events. */}
              <span className="chat-group-time">{clockTime(row.items[row.items.length - 1].createdAt)}</span>
            </div>
          </div>
        )
      )}
    </>
  );
}
