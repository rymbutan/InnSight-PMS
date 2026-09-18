import Icon from './Icon';

/**
 * A record attached to a message — a reservation, folio or guest profile —
 * drawn as a small card: type, name, secondary line.
 *
 * One component for every place a reference appears, so the thing you click
 * in a transcript, the thing waiting in the composer and the preview in the
 * "send to a colleague" dialog are recognisably the same object:
 *
 *   onOpen    makes it a button that opens the record (the transcript)
 *   onRemove  adds an ✕ (the composer's pending attachment)
 *   neither   a static preview (the share dialog)
 *
 * `record` is a RESOLVED reference — see lib/recordRefs.js resolveRef(), which
 * fills in the route, icon and type label from the stored type and id.
 */
export default function RecordChip({ record, onOpen, onRemove }) {
  if (!record) return null;
  const noun = record.typeLabel.toLowerCase();
  return (
    <span className="rec-chip">
      <button
        type="button"
        className="rec-chip-main"
        onClick={onOpen ? () => onOpen(record) : undefined}
        disabled={!onOpen}
        title={onOpen ? `Open this ${noun}` : undefined}
        aria-label={`${record.typeLabel}: ${record.label}${record.sub ? `, ${record.sub}` : ''}`}
      >
        <span className="rec-chip-icon" aria-hidden="true">
          <Icon name={record.icon} size={15} strokeWidth={1.9} />
        </span>
        <span className="rec-chip-text">
          <span className="rec-chip-type">{record.typeLabel}</span>
          <span className="rec-chip-label">{record.label}</span>
          {record.sub && <span className="rec-chip-sub">{record.sub}</span>}
        </span>
        {onOpen && <Icon name="arrow-right" size={13} strokeWidth={2} className="rec-chip-go" />}
      </button>
      {onRemove && (
        <button
          type="button"
          className="rec-chip-remove"
          onClick={onRemove}
          title="Remove attachment"
          aria-label="Remove attachment"
        >
          <Icon name="x" size={12} strokeWidth={2.2} />
        </button>
      )}
    </span>
  );
}
