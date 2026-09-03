import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// This config now only affects LOCAL DEVELOPMENT (`npm run dev` on your machine).
//
// The `web` container no longer runs the dev server: web/Dockerfile builds the
// bundle and serves it with nginx, and the gateway proxies `/` there — so in
// docker-compose there is no Vite process, no HMR websocket and no filesystem
// watching at all. It previously ran `npm run dev` in production with the source
// bind-mounted in.
//
// VITE_PROXY_TARGET is the upstream the dev server forwards `/api` requests to;
// point it at the gateway (default http://localhost:8080, which compose publishes).
// The frontend always calls relative URLs like fetch('/api/...'), so the browser
// stays on one origin — no CORS, no host mismatches.
const PROXY_TARGET = process.env.VITE_PROXY_TARGET || 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // `watch: { usePolling: true }` was here for the bind-mounted container, where
    // inotify does not fire. That container is gone, and polling a source tree
    // costs a busy CPU core for nothing on a normal filesystem.
    proxy: {
      '/api': {
        target: PROXY_TARGET,
        changeOrigin: true,
        // Keep cookies/auth headers intact when proxying.
        ws: false,
      },
    },
  },
});
