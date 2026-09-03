# Phase 2 — Deployability

Closes B4, B5, B6, C3, C4, C5, H1, H2, H3, H4. 212 unit tests still pass.

---

## ⚠️ Read this first — the startup sequence changed

Two things that used to happen implicitly now have to be run once, on purpose.

```bash
bash scripts/gen-env.sh          # 1. generate secrets  (compose won't start without them)
docker compose up -d --build     # 2. start
bash scripts/db-seed.sh          # 3. create roles, catalogues and the admin user
```

Then open **http://localhost:8080** (http://localhost:5180 still works) and sign in
as `admin` with the `ADMIN_INITIAL_PASSWORD` that `gen-env.sh` printed. You will be
forced to change it.

**Why each step is now explicit:**

1. Every secret in `docker-compose.yml` is `${VAR:?…}` with **no fallback**, so
   compose refuses to start until a `.env` exists. Previously the defaults were
   values published in this repository.
2. Unchanged.
3. Seeding is no longer in any container's `CMD`. It used to run on *every*
   container start.

If you skip step 3, the services are healthy but nobody can log in.

---

## What changed

### The frontend is no longer the Vite dev server (B4)

`web/Dockerfile` was `CMD ["npm", "run", "dev"]` with the source bind-mounted in —
the dev server *was* production. `npm run build` was never invoked anywhere in the
repo, and the gateway had no `location /`, so its fallback returned
`404 {"error":"Not found at gateway."}`.

Now a two-stage build: `npm ci` → `npm run build` → `nginx:1.27-alpine` serving
`dist`. The runtime image has no Node, no `node_modules` and no source. Gone with
it: the HMR websocket, the exposed source maps, the unminified bundles, the
`usePolling: true` watcher burning a core, and the single-threaded Node process
that was proxying every API call *and* every long-lived SSE stream.

**The gateway is now the browser's only origin.** It serves the SPA at `/`
(proxied from the `web` container, which no longer publishes a port) and handles
`/api/*` itself. `web/nginx.conf` owns the SPA history fallback, so a hard refresh
on `/reservations/42` works instead of 404ing.

This is also what makes the next item possible.

### Rate limits are per-client instead of hotel-wide (H1)

The limits were keyed on `$binary_remote_addr`, which sounds per-user but wasn't:
the browser talked to the Vite dev server, which proxied `/api` onward, so **every
request reached the gateway from one source address** — the `web` container. Login
was 10/min *for the entire hotel*; the 6th concurrent sign-in was rejected.

Two fixes, one structural and one arithmetic:

- Routing the app through the gateway means `$remote_addr` **is** the client. No
  `X-Forwarded-For` trust chain to configure or get wrong.
- The limits were also applied at `server` level, so loading the app — HTML, JS,
  and up to 20 large `.glb` models — spent the same budget as API calls. Now a
  `map` yields an *empty* rate-limit key for non-`/api` URIs, and nginx skips
  `limit_req` entirely for those. Static traffic is not counted at all.

| Zone | Before | After |
|---|---|---|
| `/api/*` | 200 r/m, burst 50, **hotel-wide** | 3000 r/m, burst 300, `delay=150`, **per address** |
| `/api/auth/login` | 10 r/m, burst 5, **hotel-wide** | 120 r/m, burst 40, `delay=10`, **per address** |
| SSE streams | uncapped | `limit_conn` 24 per address |

A NAT'd computer lab still shares one address, so the ceilings are sized for a
class rather than for one user, and `delay=` **throttles** the overflow instead of
rejecting it — 40 simultaneous logins all succeed, spread over ~20s.

Rejections are now **429**, not 503. That mattered: `web/src/api.js` rendered the
503 as *"Cannot reach the backend (gateway). Is `docker compose up` running?"*, so
throttling looked like an outage. There is now an explicit 429 message.

Also `worker_rlimit_nofile 16384` and `worker_connections 4096` — the previous
1024 was moot anyway, since the container's default `RLIMIT_NOFILE` was the real
ceiling.

### Secrets, `NODE_ENV`, non-root, lockfiles (B5, C5)

- **No secret has a default.** `POSTGRES_PASSWORD`, `JWT_SECRET` and
  `MINIO_ROOT_PASSWORD` use `${VAR:?message}`. `scripts/gen-env.sh` generates all
  of them (URL-safe for the ones interpolated into `postgresql://` URLs).
- **The weak-secret guard is fixed, not just armed.** It checked
  `length >= 32` — and the shipped default was 41 characters, so it *passed*, and
  the production hard-fail could never fire even if `NODE_ENV` had been set. It
  now also rejects this repo's published values **by value**. Propagated to all 9
  copies of `middleware/auth.js`.
- **`NODE_ENV=production`** in every service image. It was previously set nowhere
  in the entire repo, which is why that hard-fail was unreachable, pino stayed at
  `debug`, and Express kept dev-mode behaviour. Note it is set *after* `npm ci`
  deliberately: the Prisma CLI is a devDependency that `db-init.sh` needs at
  container start, and installing with `NODE_ENV=production` would skip it.
- **The admin password is no longer hardcoded or logged.** It was
  `bcrypt.hash('admin12345')` followed by a `console.log` of the plaintext — on a
  seed that re-ran on every container start, so the live credentials sat in
  `docker logs` for the lifetime of the deployment. Now it comes from
  `ADMIN_INITIAL_PASSWORD`, is rejected if short or if it's one of this repo's
  published values, is never logged, and the account is flagged `mustChangePwd`
  so it's valid for exactly one sign-in.
- **Seeding moved out of `CMD`** into `scripts/db-seed.sh`, which runs each seed
  as a one-shot `docker compose run --rm` container. Two replicas no longer race
  two seeds on the same rows.
- **Every container runs as `node`, not root.** `USER` had zero hits repo-wide.
- **All 9 services have a `package-lock.json`** (only `auth` did), and the images
  and CI use `npm ci`. Eight services were re-resolving their transitive tree on
  every build, so two builds of the same commit could ship different code.

  Note: `auth`'s pre-existing lockfile turned out to be **stale** — it predated
  `pino`, `prom-client` and `swagger-ui-express` being added to its
  `package.json`. That is invisible under `npm install`, which just resolves the
  difference silently, but `npm ci` refuses outright ("can only install packages
  when your package.json and package-lock.json are in sync"). So switching to
  `npm ci` turned a latent inconsistency into a hard build failure, which is the
  point of `npm ci`. Regenerated; all 9 are now verified in sync.
- **`.dockerignore` in all 11 build contexts.** There were none.

### Real Prisma migrations (B6)

`scripts/baseline-migrations.sh` has been run: all 9 services now have a
`00000000000000_baseline/migration.sql`, so `db-init.sh` uses `prisma migrate
deploy` instead of `db push`. That matters beyond version history — `db push`
diffs against the live database and **drops objects it doesn't know about**, which
included every raw-SQL constraint Phase 1 added (the double-booking exclusion
constraint, the one-guest-per-room partial unique index).

Two bugs found and fixed while doing it, both of the same shape:

- The script aborted on its first service with a Prisma **7** usage error, because
  a bare `npx prisma` on a machine with no local `node_modules` fetches the latest
  release, and v7 removed `--to-schema-datamodel`. Now pinned to the `^6.0.0` the
  services declare.
- That abort left `inventory` with a **0-byte** `migration.sql` — the shell creates
  the redirect target before Prisma writes to it, and `set -e` killed the script
  before its own emptiness check could run. On the next run the directory existed,
  so it was reported `SKIP … baseline already exists`.

  **This would have shipped an inventory service that creates no tables**:
  `db-init.sh` would see a baseline, switch to `migrate deploy`, apply zero DDL,
  mark it applied, and start against an empty database — the exact failure this
  project has been bitten by before. Both scripts now test for *non-empty*
  (`-s`, not `-f`), the generator regenerates a partial baseline instead of
  skipping it, and an `EXIT` trap cleans up on failure.

### 1 GB of duplicated build output removed from `src` (C3, C4)

`web/src/sim/models/` was 2.0 GB / 119 entries. Someone had run `vite build` with
`outDir` pointed into the source tree, twice.

- **41 content-hashed `.glb` duplicates** — each verified byte-identical to its
  original with `md5` before being moved. All 41 matched.
- **34 minified JS chunks + 1 CSS** from two different builds (mtimes Jun 21 and
  Jul 23). Nothing imported any of them.
- **The stale `web/dist`** — its `index.html` referenced
  `/assets/index-BW7Vpc10.js`, a chunk that was sitting in `src/sim/models/`.
  Serving it produced a blank page.

All of it is quarantined in **`.attic/`**, not deleted, because this project is not
a git repository. Read `.attic/README.md` and `rm -rf .attic` when you're happy —
that reclaims 1.0 GB.

The 41 real models moved to **`web/public/models/`** and `task3d.jsx`'s `glb()`
helper now builds `/models/<name>.glb` paths. This is the fix, not just tidying:
a `new URL('./x.glb', import.meta.url)` reference *inside* `src/` makes Vite treat
each model as a build asset and emit a hashed copy into `dist/assets` — which is
precisely how the duplicates were created. Files under `public/` are copied once,
verbatim. Verified: `dist/assets` is now 1.5 MB with **zero** `.glb`, and CI
asserts it stays that way.

### Live refresh only reloads for events a page actually renders (H2)

`useLiveRefresh(load)` defaulted to **all 30 channels**. A housekeeper posting a
minibar charge triggered a full 8-request Dashboard reload and a 4-request
Calendar reload in *every open tab*, for an event neither page displays. Six
dashboards was about the ceiling; the seventh user's storm started getting
rejected, which hit `/api/events` reconnects too and dropped everyone into 30s
backoff followed by a synchronised re-storm.

Channels are now grouped by domain (`CHANNEL_GROUPS` in `lib/useLiveEvents.js`) and
each page declares what it renders:

| Page | Subscribes to |
|---|---|
| Dashboard | reservations, stays, rooms, folio, audit |
| Calendar | reservations, stays, rooms |
| Reservations | reservations |
| Arrivals | reservations, stays |
| ReservationDetail | reservations, stays, folio |
| Rooms | rooms, maintenance |
| Folios | folio |
| Audit | audit |
| Amenities | facilities |

Three related fixes that fall out of this:

- **Amenities was a permanently dead subscription.** It asked for
  `facility:changed` / `facility:booked`, which the inventory service *published*
  but never *forwarded* — neither was in `LIVE_CHANNELS`. Amenity edits were
  invisible to every other client and nothing anywhere said so. Both channels are
  now forwarded, and the hook logs an error in dev if a page subscribes to a
  channel the server doesn't forward, so this class of bug can't recur silently.
- **No more skeleton flash.** `reload` is now called as `reload({ live: true })`,
  and pages that show a skeleton (Calendar, Reservations, Arrivals, Folios) refresh
  in place for live events instead of blanking.
- **No more mid-drag clobber.** Calendar's live reload used to replace the bar the
  user was holding with the server's copy, so the drop landed on stale geometry.
  It now defers and reloads when the drag ends.

### One shared Redis subscriber for SSE (H3)

`new Redis(...)` was **inside the request handler**: every browser tab opened its
own TCP connection and its own 30 channel subscriptions, uncapped. 50 tabs = 50
connections + 1,500 subscriptions. Cleanup hung off `req.on('close')` alone, so a
socket that *errored* rather than closing leaked both the connection and its 25s
`setInterval` for the life of the process. `res.write()`'s return value was
ignored — no backpressure at all.

Now one process-wide subscriber, one shared heartbeat, and a client registry each
message fans out to. Cost per extra tab is one `Set` entry. Plus:

- **Backpressure:** a client with >1 MiB unflushed is dropped rather than buffered
  forever. SSE clients reconnect with backoff, so dropping a stalled consumer is
  recovery.
- **Leak-proof cleanup** on `close` *and* `error`, on both `req` and `res`.
- A 500-stream ceiling, `setNoDelay`, and graceful-shutdown handling so open
  streams don't hold `server.close()` open until the 10s hard-exit timer.

### 19 Prisma connection pools → 9 (H4)

Each service called `new PrismaClient()` in every module that needed it — routes,
Redis subscriber, and for inventory/reservation the `index.js` public handlers.
19 clients across 9 processes, each with its own pool defaulting to
`cpus * 2 + 1` ≈ 9: **~171 potential connections against Postgres'
`max_connections = 100`**. The failure mode is `FATAL: sorry, too many clients
already` on every service at once.

- New `services/_shared/prisma.js`, vendored into all 9 `src/lib/` per the
  project's existing convention (`check-shared.sh` passes). One client per
  process.
- `connection_limit` on **every** `DATABASE_URL` — 20 for inventory and
  reservation (their booking transactions queue on a `FOR UPDATE` row lock and
  hold a pooled connection while waiting), 8 for the rest. **Total 96.**
- Postgres raised to `max_connections=200`, leaving headroom for the one-shot seed
  containers and a `psql` session.
- `lib/prisma.js` warns loudly if a `DATABASE_URL` arrives without a
  `connection_limit`, so this can't quietly regress.

---

## Verified

- **212/212 unit tests pass**, including inventory's 20-way booking stampede and
  its regression detector — so the Prisma-singleton rewiring provably didn't
  weaken the Phase 1 concurrency guarantees.
- `npm run build` succeeds; `dist/assets` = 1.5 MB, 0 `.glb`; `dist/models` = 42
  files copied verbatim.
- The **production bundle** was served and loaded in a browser: renders correctly,
  no console errors, and no prefilled credentials (that only happened under
  `import.meta.env.DEV`).
- Models resolve over HTTP with the right MIME type (`model/gltf-binary`), correct
  `glTF` magic bytes, and working range requests.
- `docker compose config` validates, and **fails correctly** with a clear message
  when a secret is missing.
- `scripts/check-shared.sh` passes.
- CI gained assertions for all of this: the gateway must serve the SPA at `/`, the
  history fallback must work, a model must be fetchable, and no `.glb` may appear
  in `dist/assets`.

**Not verified end-to-end:** `docker compose up` itself. The Docker daemon was not
running on this machine and there is no local nginx binary, so the two nginx
configs were reviewed but not started, and the full stack was not booted. Do this
before relying on it:

```bash
bash scripts/gen-env.sh && docker compose up -d --build && bash scripts/db-seed.sh
```

---

## Still open

- **The CI lint job still cannot pass (C1).** Prettier fails on **164 files** —
  essentially the whole repo, almost all of it untouched by this phase — and
  ESLint reports 239 `no-unused-vars` warnings that are mostly false positives
  from a config with no React/JSX plugin, plus 1 error from an
  `eslint-disable-line react-hooks/exhaustive-deps` comment for a plugin that
  isn't installed. This is Phase 5 step 38 and is a formatting/config sweep, not a
  code defect. `check-shared.sh` and the room-layout check inside that job do pass.
- **`web/public/models` is still ~1 GB**, so the web build context is heavy and CI
  will be slow. Phase 3 step 21 (`gltf-transform` + meshopt) takes it to ~20 MB.
  Only then does that stop hurting.
- **Services still publish raw ports 3005–3013**, so the gateway's rate limiting
  is bypassable by hitting a service directly. That's H13/S6, Phase 5 step 36 —
  fixing it here would have broken the existing `scripts/*.mjs` tooling.
- **MinIO is still dead infrastructure** (M7). Its password is now required rather
  than defaulted, but nothing in the codebase talks to it; consider deleting the
  service.
- Phase 1's known gaps are unchanged — see `PHASE_1_CHANGES.md`, in particular
  `POST /api/stays/:id/extend` not claiming its added nights.
