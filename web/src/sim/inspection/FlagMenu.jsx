import { useEffect } from 'react';
import { offerableCategories } from './categories';
import Icon from '../../components/Icon';

// The judgment step. Clicking an object is only half the answer — the student
// must also say WHAT KIND of fault it is, because "left behind by the
// attendant" and "never restocked" are corrected with different people.
//
// "This is correct" is a first-class choice, not an escape hatch: signing off a
// clean room confidently is part of the competency, and it is the option that
// makes flagging everything a losing strategy.
export default function FlagMenu({ anchor, onChoose, onCancel }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  if (!anchor) return null;

  return (
    <div className="insp-flag-backdrop" onClick={onCancel}>
      <div className="insp-flag" onClick={(e) => e.stopPropagation()}>
        <h3>{anchor.label}</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          What is wrong here — if anything?
        </p>

        <button className="insp-flag-ok" onClick={() => onChoose('ok')}>
          <Icon name="check" size={14} strokeWidth={2.4} />
          This is correct — no issue
        </button>

        <div className="insp-flag-list">
          {offerableCategories().map((o) => (
            <button key={o.id} className="insp-flag-opt" onClick={() => onChoose(o.id)}>
              {o.label}
            </button>
          ))}
        </div>

        <button className="secondary small" onClick={onCancel} style={{ marginTop: 10 }}>
          Cancel — keep looking
        </button>
      </div>
    </div>
  );
}
