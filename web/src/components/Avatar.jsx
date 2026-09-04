// Profile photo when the account has one, otherwise a deterministic
// initials circle: the name is hashed into an HSL hue so "Maria Santos"
// always gets the same shade, and the initials fall back gracefully.

import { useAvatarUrl } from '../lib/useAvatar';

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Pass `userId` + `avatarUpdatedAt` to show an uploaded photo; with neither (or
// for an account that has never set one) this stays the initials circle it has
// always been, so every existing caller keeps working unchanged.
export default function Avatar({ name, size = 32, title, userId, avatarUpdatedAt }) {
  const photo = useAvatarUrl(userId, avatarUpdatedAt);
  const n = name || '';
  const h = hash(n) % 360;
  const bg = `hsl(${h}, 55%, 45%)`;
  const style = {
    width: size,
    height: size,
    borderRadius: '50%',
    background: bg,
    color: '#fff',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: Math.round(size * 0.42),
    fontWeight: 600,
    letterSpacing: 0.5,
    flexShrink: 0,
    userSelect: 'none',
    overflow: 'hidden',
  };
  return (
    <span className="avatar" style={style} title={title || n}>
      {photo ? (
        <img
          src={photo}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        initials(n)
      )}
    </span>
  );
}
