# InnSight web frontend — production image.
#
# The previous version of this file ran `npm run dev`, i.e. it shipped the Vite
# DEV SERVER as production: HMR websocket, unminified bundles, exposed source
# maps, `usePolling: true` filesystem watching burning a CPU core, and a
# single-threaded Node process proxying every API call and every long-lived SSE
# stream. `npm run build` was never invoked anywhere in the repo.
#
# Now: build the bundle in a throwaway Node stage, ship only `dist` on nginx.
# The runtime image carries no Node, no node_modules and no source.

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Copy manifests first so `npm ci` is cached independently of source edits.
# `npm ci` (not `npm install`) — installs exactly the committed lockfile.
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public

# No VITE_API_URL: the frontend calls relative /api paths and is served from the
# same origin as the gateway, so there is nothing to configure. See web/src/api.js.
ENV NODE_ENV=production
RUN npm run build

# ── Stage 2: serve ───────────────────────────────────────────────────────────
FROM nginx:1.27-alpine

# Static server config: SPA history fallback + asset cache headers.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

# 8080 (not 80) so the worker never needs a privileged port. The official nginx
# image already runs its workers as the unprivileged `nginx` user.
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/index.html >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
