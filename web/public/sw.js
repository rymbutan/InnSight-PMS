// Service worker for the installed/standalone app shell.
//
// WHAT THIS DOES NOT DO, on purpose: cache anything under /api/. This is a
// hotel front desk, not a news reader — a housekeeper looking at yesterday's
// room status because a service worker served it from cache is worse than no
// offline support at all. Every /api/ request bypasses this file entirely and
// goes straight to the network, same as if this file did not exist.
//
// What it DOES cache, and why each policy is safe from staleness:
//   - /assets/* — Vite's own bundle output, content-hashed into the filename
//     (index-<hash>.js). Cache-first is safe here specifically BECAUSE the
//     hash changes whenever the content does: an old bundle at an old URL is
//     never re-requested once a fresh index.html points at new hashes, so
//     there is no "stuck on an old version" failure mode to design around.
//   - Navigations (index.html) — network-first, falling back to the cache
//     only when the network genuinely fails. This is the one request that
//     COULD go stale if cached aggressively, so it never is: an online visit
//     always gets the live HTML (and the live HTML is what has July's JS
//     hashes), and the cache only exists as a last resort for a moment of bad
//     connectivity, not as a substitute for a real reload.
//
// Nothing here reaches a network origin other than the one serving the app —
// same constraint the rest of the system is built around.
const CACHE = 'innsight-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(['/', '/manifest.json']))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Cross-origin, non-GET, and /api/* all pass through untouched — this
  // worker only ever answers for the app shell it owns.
  if (url.origin !== self.location.origin) return;
  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return res;
        });
      })
    );
  }
});
