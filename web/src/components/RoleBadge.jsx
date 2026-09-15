import { roleColor, roleLabel } from '../lib/roles';

// The role capsule. ONE component for every place a role is shown — the top bar
// and the Users table both render this, so the two cannot drift apart in shape,
// size or colour the way two hand-styled spans would.
//
// `upper` is the top bar's treatment: uppercase and letter-spaced, because there
// it stands alone as an identity marker. In a table the sentence-case label
// reads better beside the surrounding text.
export default function RoleBadge({ code, upper = false, title }) {
  if (!code) return null;
  return (
    <span
      className={`role-badge${upper ? ' is-upper' : ''}`}
      style={{ background: roleColor(code) }}
      title={title || roleLabel(code)}
    >
      {upper ? roleLabel(code).toUpperCase() : roleLabel(code)}
    </span>
  );
}
