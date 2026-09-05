import { useEffect, useState } from 'react';
import { API_BASE } from '../api';

// Fetches a user's profile photo as a blob URL.
//
// WHY NOT JUST <img src="/api/auth/avatar/:id">
// ---------------------------------------------
// GET /api/auth/avatar/:userId is behind verifyToken, and an <img> element
// cannot send an Authorization header — the browser would issue a bare,
// anonymous GET and receive 401. The alternatives were to make staff photos
// public to anyone who can guess a UUID, or to mint per-image tickets the way
// the SSE stream does. Fetching with the header and handing the element an
// object URL keeps the route authenticated without either.
//
// `version` is the user's avatarUpdatedAt. It is the cache key: without it a
// freshly uploaded photo would sit behind the route's 5-minute private cache.
// A null version means "no photo" and skips the request entirely, so accounts
// without one cost no network at all.
export function useAvatarUrl(userId, version) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!userId || !version) {
      setUrl(null);
      return undefined;
    }
    let objectUrl = null;
    let cancelled = false;

    (async () => {
      try {
        const token = localStorage.getItem('innsight_token');
        if (!token) return;
        const r = await fetch(`${API_BASE}/api/auth/avatar/${encodeURIComponent(userId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        // 404 is the normal "no photo" answer, not an error worth surfacing.
        if (!r.ok) return;
        const blob = await r.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        /* offline or signed out — the monogram fallback stands in */
      }
    })();

    return () => {
      cancelled = true;
      // Object URLs are held by the document until explicitly revoked, so
      // skipping this leaks the whole image on every avatar change.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [userId, version]);

  return url;
}
