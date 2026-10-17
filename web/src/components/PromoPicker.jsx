import { usePromoOptions, promoHint } from '../lib/promo';

// The promo field on the booking forms: a dropdown of the codes the desk may
// use right now, instead of a free-text box. The chosen code is still validated
// by usePromo (and again by the server), so the summary and the saved total can
// never disagree with what the picker offered.
export default function PromoPicker({ code, setCode, state }) {
  const options = usePromoOptions();
  const hint = promoHint(state);
  // A code that is set but no longer on the list (it expired while the form was
  // open) stays selectable so the select never silently shows "No promo" while
  // a discount is still applied.
  const known = options.some((o) => o.code === code);
  return (
    <>
      <select value={code} onChange={(e) => setCode(e.target.value)}>
        <option value="">No promo code</option>
        {code && !known && <option value={code}>{code}</option>}
        {options.map((o) => (
          <option key={o.code} value={o.code}>
            {o.code} — {o.percentOff}% off{o.description ? ` · ${o.description}` : ''}
          </option>
        ))}
      </select>
      {hint && <div style={{ fontSize: 12, marginTop: 4, color: hint.color }}>{hint.text}</div>}
    </>
  );
}
