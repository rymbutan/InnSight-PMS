// The booking the student is inspecting against.
//
// This panel is the whole reason the exercise is analytical rather than
// spot-the-difference: two twin beds are only wrong once you know a couple is
// arriving. It opens on entry and stays reachable throughout — students are
// meant to re-read it, not memorise it.
//
// On a real room these are the real reservation's details, checkable against the
// PMS. A practice drill has no room and so no guest, and says so — a student who
// cannot tell the two apart learns either to distrust a real clipboard or to
// trust an invented one.

export default function Clipboard({ caseFile, open, onClose }) {
  if (!open) return null;
  const {
    confirmationNumber,
    guestName,
    adults,
    children,
    pax,
    roomTier,
    nights,
    arrival,
    specialRequests,
    fromReservation,
  } = caseFile;

  return (
    <div className="insp-clipboard">
      <div className="insp-clipboard-head">
        <h3>Booking</h3>
        {fromReservation === false && <span className="insp-practice">Practice</span>}
        <button className="secondary small" onClick={onClose}>
          Close
        </button>
      </div>

      <dl className="insp-booking">
        <dt>Confirmation</dt>
        <dd>{confirmationNumber}</dd>

        <dt>Guest</dt>
        <dd>{guestName}</dd>

        <dt>Party</dt>
        <dd>
          <strong>{pax}</strong> {pax === 1 ? 'guest' : 'guests'} — {adults} adult
          {adults === 1 ? '' : 's'}
          {children > 0 ? `, ${children} child${children === 1 ? '' : 'ren'}` : ''}
        </dd>

        <dt>Room type</dt>
        <dd>{roomTier}</dd>

        <dt>Arrival</dt>
        <dd>
          {arrival} · {nights} night{nights === 1 ? '' : 's'}
        </dd>

        <dt>Special requests</dt>
        <dd className={specialRequests ? 'insp-request' : 'muted'}>{specialRequests || 'None on file.'}</dd>
      </dl>

      <p className="muted insp-hint">
        {fromReservation === false
          ? 'A practice booking — no guest is really arriving. Inspect the room against it anyway.'
          : 'This is the room’s reservation. Inspect the room against it.'}{' '}
        Press <kbd>C</kbd> to reopen at any time.
      </p>
    </div>
  );
}
