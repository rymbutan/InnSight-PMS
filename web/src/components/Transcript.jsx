import { useNavigate } from 'react-router-dom';
import RecordChip from './RecordChip';
import { clockTime, dayLabel } from '../lib/messageGroups';
import { refOf } from '../lib/recordRefs';

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
 *
 * A message may carry a record — a reservation, folio or guest — which is drawn
 * as a chip under its text (or on its own, when there is no text). Clicking it
 * opens the record IN PLACE: the dock is mounted in the app shell and survives
 * navigation, so the conversation stays in the corner while the record page
 * comes up behind it. `onOpenRecord` lets a surface do something more than
 * navigate — the Messages page uses it to hand the thread to the dock first,
 * because leaving that page would otherwise close the conversation the reader
 * just clicked out of.
 */
export default function Transcript({ rows, onOpenRecord, peerName }) {
  const navigate = useNavigate();
  // Re-derived each render rather than captured once, so a thread left open
  // across midnight relabels "Today" instead of insisting it still is.
  const now = new Date();
  const openRecord = (record) => {
    if (onOpenRecord) onOpenRecord(record);
    else navigate(record.path);
  };
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
              {/* Who this turn belongs to — the same fact the side a bubble
                  sits on already carries, but named rather than implied, the
                  way the reference design labels each cluster. Inside
                  .chat-group-bubbles (not a sibling of it) so it inherits the
                  same column stacking and left/right alignment as the
                  bubbles beneath it. Only rendered when the caller hands over
                  a name, so a surface with no peer to name (there is none
                  right now) just keeps the old unlabelled look instead of
                  printing "undefined". */}
              {peerName && <span className="chat-group-name">{row.mine ? 'You' : peerName}</span>}
              {row.items.map((m) => {
                const record = refOf(m);
                return (
                  <div className={`chat-bubble${record ? ' has-record' : ''}`} key={m.id}>
                    {m.body ? <span className="chat-bubble-body">{m.body}</span> : null}
                    {record && <RecordChip record={record} onOpen={openRecord} />}
                  </div>
                );
              })}
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
