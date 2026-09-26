// The show/hide icon for password reveal toggles (Login, RequestAccess,
// ResetPassword). Was a pair of emoji (👁 / 🙈) — the monkey read as a joke
// rather than a control, so both states are now the same currentColor SVG
// glyph a reveal toggle usually gets.
export default function EyeIcon({ off = false }) {
  return off ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.64-7 10-7c1.4 0 2.63.27 3.7.7M22 12s-3.64 7-10 7c-1.86 0-3.4-.47-4.66-1.14M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.64-7 10-7 10 7 10 7-3.64 7-10 7-10-7-10-7Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
