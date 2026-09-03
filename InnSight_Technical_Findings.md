# InnSight PMS — Technical Findings

Audit date: 2026-07-29. All findings verified against source; file:line references included.

> **Status update — Phase 1 implemented (2026-07-29).**
> B1, B2, B3, B5(partial), B6, H5, H6(partial), H8, H9(partial), H11(partial), M1, M4 are fixed.
> 212 unit tests pass. See `PHASE_1_CHANGES.md` for what changed and the two
> commands you must run before deploying.
>
> **Status update — Phase 2 implemented (2026-07-29).**
> B4, B5, B6, C3, C4, C5, H1, H2, H3, H4 are fixed, plus the rest of H6's
> live-refresh half and H9's dead Amenities subscription. 212 unit tests still
> pass. See `PHASE_2_CHANGES.md`.
>
> **The startup sequence changed** — compose now refuses to start without a `.env`,
> and seeding is no longer automatic:
> ```
> bash scripts/gen-env.sh && docker compose up -d --build && bash scripts/db-seed.sh
> ```
> Still open from the Phase 2 range: C1 (the lint job remains unpassable — a
> repo-wide formatting sweep, Phase 5 step 38).
>
> **Status update — Phase 3 implemented (2026-07-29).**
> D1, D2, D3, D4, D5, D6, D7, D8 are fixed. Models went **1011 MB → 44 MB**
> (16.9M → 2.9M triangles) and all four tiers now pass a layout validator that
> checks 3D geometry, not just 2D footprints. See `PHASE_3_CHANGES.md`.
> Not in Phase 3's scope and still open: D9 (the layout editor's lighting doesn't
> match the game view).
>
> **Status update — Phase 4 implemented (2026-07-29).**
> G1, G3, G4, G5, G6, G7, G8, G9, G10, G11, G12 are fixed. 220 unit tests pass.
> See `PHASE_4_CHANGES.md`.
>
> It also found a bug this report missed: `training.routes.js` keyed its score table
> `{ GOOD: 1, ISSUES: 0.5 }` while the sim sends lowercase `'good'`/`'issues'`, so
> **every training run ever recorded scored 0%** and the competency table was
> meaningless. Fixed and pinned with 8 regression tests.
>
> **Status update — Phase 5 implemented (2026-07-29). PROJECT COMPLETE.**
> S2, S3, S4, S5, H11, H12, H13, C1, C2, C6 are fixed; S1 and S6 are partially fixed
> (machine/human signing keys split and JWT claims pinned, security headers added —
> asymmetric issuance, TLS and `zod` validation are not done). 240 unit tests pass and
> **the CI lint job passes for the first time**. See `PHASE_5_CHANGES.md`.
>
> `SERVICE_JWT_SECRET` is now a required secret — run `bash scripts/gen-env.sh --force`.
>
> There is now a `README.md`. Each `PHASE_N_CHANGES.md` records what changed, why, and
> what was *not* verified. `PHASE_5_CHANGES.md` closes with a table of everything
> consciously left open (S7, H7, H10, M2, M3, M5, M6, M7, D9).
>
> **Follow-up — 2026-07-30.** Two fixes on top of the five phases, both found by
> actually opening the app rather than by any build or test:
>
> - **Phase 5's CSP silently broke the whole of Phase 3.** `script-src 'self'` blocks
>   the meshopt WASM decoder, and `connect-src 'self'` blocks the blob `fetch()` that
>   `GLTFLoader` uses for textures — so the training sim and the layout editor both
>   rendered an empty room. Models still returned HTTP 200, which is all CI checked.
>   Fixed with `'wasm-unsafe-eval'` and `connect-src … blob:`, and the smoke job now
>   asserts both on the live header. Details in `PHASE_5_CHANGES.md`.
> - The `/sim-demo` harness is now an **ADMIN-only** in-app page, *Room Layouts (3D)*
>   (`/room-layouts`). It was previously an unlisted URL any authenticated account
>   could reach, including a housekeeping trainee — the same class of problem as S3.
> - **Pressing `d` during a training shift dumped the trainee on the dashboard and
>   destroyed their run.** The app's global shortcuts bind bare letters (`d` =
>   dashboard) and the sim walks with WASD; both listeners are on `window`, so the
>   sim's `preventDefault()` could not stop it. `n c r g t` were the same hazard.
>   Full-screen surfaces now own the keyboard — `components/KeyboardShortcuts.jsx`
>   ignores shortcuts while `.cg-overlay` or `[data-keyboard-capture]` is present.
> - The sim's own walk handler was tightened at the same time: it claimed WASD and
>   the arrow keys (with `preventDefault`) **regardless of focus**, so any text field
>   reachable during a shift would silently lose those characters and its caret
>   movement, and typing an "l" toggled mouse-look. It now ignores keys while focus is
>   in a field, only tracks the keys movement actually reads, and releases held keys on
>   unmount.
>
> **Status update — 2026-08-18. The mini-games this report critiques no longer exist.**
> Section 3 of the panel's *Changes to be made in the System* asked for the 3D
> simulation to become "a procedural, analytical case study" instead of "a simple
> gamified bed-making task", and for the mini-games to be removed. They were.
>
> This makes the whole **HIGH — mini-games** section below (and finding 3 in the
> summary) **moot rather than outstanding**: `CleaningGame`, `BedMaking3D`,
> `Bathroom3D`, `Minibar3D`, `Ac3D`, `Linen3D`, `Vacuum3D`, `Inspection3D`,
> `LostFoundGame`, `GuestRequestGame`, `extraTasks` and `mechanics` were deleted,
> along with the no-WebGL 2D fallback hub and the hardcoded `procedure: GOOD` in
> `Vacuum3D`. The findings are left in place unedited because they are the record
> of why the replacement was built the way it was.
>
> What runs now is `web/src/sim/inspection/` — see
> `docs/superpowers/specs/2026-08-18-3d-inspection-case-study-design.md`. The room
> renderer, the `.glb` pipeline and the layout editor were all kept.
>
> Everything in this report that is **not** about the mini-games still stands,
> including the concurrency ceiling below and the Vite-dev-server-in-production
> finding.
---

## Answer to your three questions, up front

**1. How many simultaneous users?** Realistically **5–6**, and correctness breaks at **2**. Two separate ceilings:

- **Correctness ceiling = 1 user.** `POST /api/reservations` performs *no availability check at all* (`services/reservation/src/routes/reservation.routes.js:45-102` — it validates 4 fields then calls `prisma.reservation.create`). Two front-desk users booking the same room for the same nights both succeed, every time. This is not a race condition; it is unconditional.
- **Throughput ceiling ≈ 6 users.** The nginx login rate limit is `rate=10r/m burst=5` keyed on `$binary_remote_addr` (`services/gateway/nginx.conf:41,97`) — but the browser never talks to nginx directly, so nginx sees one IP (the `web` container) for all traffic. The limit is therefore **hotel-wide, not per-user**. A class of 30 students logging in at once: 5 get through, 25 get HTTP 503.

**Yes, changes do propagate live** — there is a working SSE + Redis pub/sub layer (`services/inventory/src/index.js:114-144`, `web/src/lib/useLiveEvents.js`) with reconnect and backoff. But it has three holes: adding a room / room type / rate plan publishes **nothing**, the Amenities page subscribes to two channels the server never forwards, and every event triggers a full refetch on every page regardless of relevance.

**2. The 3D room** — the problem isn't your assets. You own 82 GLB models. Three root causes: the auto-fit scaler is mathematically wrong (the king bed renders as a 2.40 × 2.39 m square, 1.01 m tall), three of four room tiers use **zero** GLBs (78 of 78 fixtures are grey primitive boxes), and there's no `<Environment>` so every material is matte plastic and every metal renders near-black.

**3. The mini-games** — nothing is a literal stub, but 4 of 13 Presidential stations are **the same component with different label text**, most "interaction" is HTML buttons and number steppers, no activity has a fail state, and 2 of 3 top-level games throw the student's results away on close.

---

## BLOCKERS — must fix before any deployment

### B1. No availability check on staff reservation creation
`services/reservation/src/routes/reservation.routes.js:45-102`. Zero capacity query, zero transaction, zero room-collision check on `assignedRoomId`.

Repo-wide: `FOR UPDATE` → 0 hits. `pg_advisory_lock` → 0 hits. Raw SQL (`$queryRaw`/`$executeRaw`) → 0 hits. `isolationLevel`/`SERIALIZABLE` → 0 hits. `$transaction` → only 6 sites in application code (folio ×4, guest ×1, inventory ×1).

**Fix:** wrap create in a transaction that locks the room type row (`SELECT ... FOR UPDATE`) and re-checks capacity, plus a Postgres exclusion constraint on `(assignedRoomId, daterange(checkIn, checkOut))` using `EXCLUDE USING gist` as the last line of defence.

### B2. Public booking is a cross-database TOCTOU that cannot be transactional
`services/reservation/src/index.js:56-79` checks availability via an **HTTP call to the inventory service**, which uses a **different database** (`innsight_inventory` vs `innsight_reservation`, `docker-compose.yml`). A cross-DB transaction is impossible by construction. Two guests booking the last room: both read `available: 1`, both pass the `<= 0` guard, both insert.

**Fix:** move the authoritative hold into inventory and make booking a two-phase reserve→commit against inventory's DB, or collapse reservation+inventory into one database.

### B3. The capacity check that exists is dead code
`services/inventory/src/routes/inventory.routes.js:120-133` (`POST /api/holds`) has a real `totalInventory` comparison inside a `$transaction`. Nothing calls it — grep `web/src` for `/api/holds` returns no callers.

Holds are actually created by the Redis subscriber (`services/inventory/src/subscribers/redis.subscriber.js:58-77`), which has **no `totalInventory` comparison and no transaction**. So oversell isn't a narrow race — it's unbounded. Also, the `already === 0` guard is itself a TOCTOU, and `NewReservation.jsx:148-150` fires `created` then `confirmed` back-to-back, so duplicate hold sets are possible.

### B4. Production frontend is the Vite **dev server**
`web/Dockerfile:7` → `CMD ["npm", "run", "dev"]`. Source is bind-mounted in. `npm run build` is never invoked in any Dockerfile. `nginx.conf` has no `location /` for the SPA — the fallback returns `404 {"error":"Not found at gateway."}`.

Consequences: HMR websocket in production, unminified bundles, source maps exposed, `usePolling: true` filesystem watching burning a CPU core, and a single-threaded Node process proxying every API call *and* every long-lived SSE stream.

**Fix:** multi-stage Dockerfile (`npm ci` → `npm run build` → `nginx:alpine` serving `dist` with SPA fallback), drop the source mounts, add `location /` at the gateway.

### B5. Every secret has a working default; admin password is seeded and logged on every boot
- `services/auth/src/seed.js:119` → `bcrypt.hash('admin12345', 10)`
- `services/auth/src/seed.js:130` → `console.log(...password=admin12345...)`
- `services/auth/Dockerfile:8` → seed runs on **every** container start
- `docker-compose.yml` → `POSTGRES_PASSWORD:-innsight_dev_2025`, `MINIO_ROOT_PASSWORD:-innsight_dev_2025`, `JWT_SECRET:-innsight_slsu_capstone_jwt_secret_2025`

The default JWT secret is 41 chars, so the ≥32-char guard in `middleware/auth.js:6` **accepts it** and the production hard-fail never triggers. `NODE_ENV` is never set anywhere, so that guard is unreachable regardless.

**Fix:** `${JWT_SECRET:?required}` syntax on all secrets, move seeding to a one-shot job, require `ADMIN_INITIAL_PASSWORD`, never log it, set `mustChangePwd: true`.

### B6. No database migrations
No `migrations/` directory in any service. Every Dockerfile runs `npx prisma db push` at container start. `scripts/migrate.sh:5-6` confirms this is intentional. No version history, no rollback, and any change requiring data loss crash-loops the service.

This also blocks horizontal scaling: two replicas = two concurrent `prisma db push` (concurrent DDL) + two concurrent `seed.js` runs.

---

## HIGH — concurrency and scale

### H1. nginx rate limits are global, not per-user
`nginx.conf:41-42,74,97`. Keyed on `$binary_remote_addr`, but Vite's proxy doesn't set `X-Forwarded-For` (`xfwd` not enabled in `vite.config.js`) and nginx doesn't read it anyway. One effective client IP for the whole hotel.

- Login: **10/min, burst 5** hotel-wide → the 6th concurrent login gets 503, rendered by `api.js:41-46` as the misleading *"Cannot reach the backend (gateway). Is `docker compose up` running?"*
- API: **200/min = 3.3 req/s** hotel-wide, burst 50.

### H2. Live-event fanout amplification against that budget
`Dashboard.jsx:31-40` issues **8 requests per reload** and `:77` `useLiveRefresh(load)` subscribes to **all 30 channels** with no filter. `Calendar.jsx:40-45,55` does 4 requests, also all 30 channels. Debounce is 600 ms and per-client, so it doesn't collapse across users.

A housekeeper posting a minibar charge (`folio:charge_posted`) triggers a full 8-request Dashboard reload and 4-request Calendar reload in **every open tab** — for an event neither page displays.

Arithmetic vs `burst=50`: 6 Dashboard users = 48 requests in 600 ms (just under). **7 users = 56 = 503 storm.** The 503s hit `/api/events` reconnects too, so clients drop into 30 s backoff, then all reconnect and re-storm.

### H3. One dedicated Redis connection per browser tab
`services/inventory/src/index.js:129-130` — `new Redis(...)` **inside the per-request handler**. No shared subscriber, no multiplexing, no connection cap. 50 tabs = 50 TCP connections + 50 × 30 channel subscriptions. Cleanup is on `req.on('close')` only, so an errored socket leaks the connection *and* the 25 s `setInterval` forever. `res.write()` return value is ignored — no backpressure.

### H4. 19 unconfigured Prisma connection pools vs Postgres `max_connections=100`
No `connection_limit` on any `DATABASE_URL`; no `max_connections` tuning in compose. Each service instantiates multiple `PrismaClient`s (inventory 3: `index.js:29`, `subscribers/redis.subscriber.js:4`, `routes/inventory.routes.js:15`; reservation 3; auth 3; stay/folio/guest/maintenance 2 each). Prisma default is `cpus × 2 + 1` ≈ 9 per client on 4 cores → **171 potential connections against a 100 limit**. Manifests as `FATAL: sorry, too many clients already` — total outage, not graceful degradation.

### H5. Missing indexes on every hot query path
- `Reservation`: only `confirmationNumber @unique`. **No index on `checkIn`, `checkOut`, `status`** — the Calendar's primary query is a sequential scan.
- `InventoryHold`: **no index at all**, not even `(roomTypeCode, date)` which every availability query filters on.
- `Stay`: zero indexes, yet `/api/arrivals`, `/api/departures`, `/api/in-house` all filter it.
- `FolioTransaction.folioId`, `Payment.folioId`: no index, despite being the join path for every statement and daily-total.

Index counts by service: stay **0**, reports **0**, audit 1, folio 1, reservation 2, auth 3, guest 3, inventory 3, maintenance 3. `onDelete` → **0 hits repo-wide** (every relation uses Prisma's implicit default, never a deliberate choice).

### H6. No optimistic concurrency — last write wins silently
`PATCH /api/reservations/:id` (`reservation.routes.js:151-187`) has no `updatedAt` check, no `If-Match`/ETag, no version column. Two agents dragging the same booking on the Calendar: the second silently overwrites the first, and the `reservation:updated` publish makes the first agent's screen snap to the other person's values with no conflict indication.

`Calendar.jsx:55` also calls `load()` on live events *during* an in-progress drag, and `load()` sets `setLoading(true)` so the Calendar flashes its skeleton whenever anyone anywhere touches anything.

### H7. Idempotency layer can never deduplicate
The middleware itself is well built (Redis `SET NX EX`, namespaced by service + user + method/path, 24 h replay cache, fail-open). But `web/src/api.js:31-33` mints a **fresh UUID per HTTP request**, not per logical user intent. Two clicks on "Confirm" = two different keys = two reservations. Also `WalkIn.jsx:82`'s submit button isn't disabled while submitting.

### H8. Walk-in room assignment is validated client-side only
`WalkIn.jsx:23-24` computes availability in the browser. Server side, `POST /api/walk-in` (`stay.routes.js:164-178`) is a bare `prisma.stay.create` with **no check that the room exists, is clean, or is unoccupied**. `POST /api/check-in` (`:69-124`) guards on stay status but never checks whether `assignedRoomId` is already occupied by a different stay. `Stay.assignedRoomId` has no `@unique`.

### H9. Professor's config changes are half-invisible
No `redis.publish` on: `POST /api/room-types` (`inventory.routes.js:226-245`), `POST /api/rooms` (`:279-298`), `POST /api/rate-plans` (`:330-350`), `POST /api/promo-codes` (`:548-570`). Add a room type → nobody sees it until manual refresh.

`Amenities.jsx:47` subscribes to `['facility:changed', 'facility:booked']` — **neither is in the server's `LIVE_CHANNELS`**, so amenity edits are permanently invisible to other clients. 13 published channels total can never reach a browser, including all 7 `auth:*` and both `payment:*`.

Reducing `totalInventory` is validated only as `>= 0` (`:261-264`). Set a type with 40 active holds to `1` and availability becomes `Math.max(0, 1 - 40) = 0` — existing reservations untouched, no warning, and the `Math.max` **actively hides** the oversell.

### H10. No cross-service referential integrity, and it's structurally unfixable
Nine separate databases (`init-db.sql:4-12`). `Reservation.roomTypeCode`, `Reservation.assignedRoomId`, `Stay.assignedRoomId`, `InventoryHold.reservationId` are all bare strings pointing into other databases. Nothing validates they refer to anything real. There is also no `DELETE` endpoint for rooms, room types, rate plans, facilities, or promo codes — so the "professor deletes a room type" scenario can't happen yet, but nothing prevents orphans when it does.

Multi-step orchestrations partially commit: `audit.routes.js:158-202` posts room charges one folio at a time, collecting errors and continuing; `folio.routes.js:125-129` links folio→facility with a fire-and-forget `.catch(console.warn)`.

### H11. Inter-service calls have no timeout
`audit.routes.js:37-51`, `reports.routes.js:13-22`, `folio.routes.js:85,125`, `reservation/index.js:56,71` — all `fetch()` with no `signal`. Node's fetch has no default timeout. Only `auth/src/index.js:80-82` gets it right with a 2 s `AbortController`.

Worst case: night audit (`audit.routes.js:152-245`) does **3 sequential cross-service HTTP calls per in-house stay**. At 100 occupied rooms that's 300+ serialized round trips in one request, no batching, no timeouts.

### H12. No `unhandledRejection` / `uncaughtException` handlers anywhere
Zero hits repo-wide. Under Node 20 an unhandled rejection kills the process; with `restart: unless-stopped` that's a silent crash-loop. `auth.routes.js:77` has an uncaught `redis.publish(...)` and the auth service registers no `redis.on('error')` handler (unlike audit/reservation).

### H13. Not horizontally scalable
`replicas` / `deploy:` / `cpus` / `mem_limit` → 0 hits in compose. No k8s, Terraform, or Helm. The nginx gateway is a single container (`worker_connections 1024`, no `worker_rlimit_nofile`, so actually capped by the container's default `RLIMIT_NOFILE`). Every service also publishes its raw port to the host (`3005`–`3013`), so the gateway's rate limiting and CORS can be bypassed entirely by hitting `:3010/api/auth/login` directly.

---

## HIGH — security

### S1. One shared symmetric JWT secret; services mint their own ADMIN tokens
`folio.routes.js:17` → `jwt.sign({ sub: 'system.folio', roles: ['ADMIN'] }, JWT_SECRET, { expiresIn: '2m' })`. Same in `audit.routes.js:18-30` and `reports.routes.js:20-30`. Any one compromised service yields forgeable ADMIN tokens platform-wide, with no way to distinguish machine from human tokens. `jwt.verify` pins no `algorithms`, `issuer`, or `audience` (`middleware/auth.js:20`).

**Fix:** RS256/EdDSA — auth holds the private key, services verify with the public key. Separate service credential with a `svc: true` claim.

### S2. JWTs in URL query strings, written to nginx access logs
`services/inventory/src/index.js:117` — SSE auth via `req.query.token`. `nginx.conf:11-13` logs `"$request"`, which includes the query string. Every live-dashboard connection persists a valid **12-hour** bearer token to `/var/log/nginx/access.log`, browser history, and any intermediate proxy.

### S3. Financial and PII reads have no role check
Auth is enforced service-wide, but authorization is per-route and the reads were left open. Any authenticated user — including a HOUSEKEEPING trainee account — can read:

- `folio.routes.js:142,194,245,260,631,731` — all folios, daily totals, statements, printable folios
- `guest.routes.js:44,68,128,251` — guest search and full profiles *including* contacts, preferences, consents, loyalty
- `reports.routes.js:113,127,141,154` — arrivals, departures, in-house, room-status
- plus unguarded reads in stay, reservation, maintenance, inventory

Their write siblings correctly use `requireRole(...)`. `requirePermission` exists in `middleware/auth.js:37-45` and is **never called anywhere**.

**Fix:** default-deny at the router level, whitelist genuinely open routes.

### S4. Logout is a no-op; no revocation
`auth.routes.js:146-149` publishes an event and returns success — the JWT stays valid for its full 12 h TTL. Disabling a user or changing their password does not invalidate outstanding tokens. Roles are baked into the token, so a role change takes up to 12 h to apply. Token lives in `localStorage` (XSS-readable). SSE authorization is checked **once at connect**, so a disabled user keeps receiving every business event in the hotel until they close the tab — and there's no per-role channel filtering, so a housekeeper's stream carries `folio:payment_received` and `audit:day_closed`.

### S5. All three PDF/print features are broken
`Folios.jsx:87`, `Arrivals.jsx:92`, `ReservationDetail.jsx:118` all use `window.open(...)`, which sends no `Authorization` header. The token is attached only by the axios interceptor. Both endpoints sit behind `verifyToken`, so the new tab renders `{"error":"Missing bearer token."}` instead of a PDF.

### S6. No validation library, no security headers, no TLS
`helmet` / `zod` / `joi` / `express-validator` / `express-rate-limit` → **0 hits** across all 9 services. Validation is ad-hoc truthiness checks. Query params flow straight into Prisma `where` clauses — no SQL injection risk (Prisma parameterizes; verified zero raw-SQL calls), but an invalid enum yields a 500 instead of a 400. `express.json()` with no `limit` = 100 kb default, while nginx allows 20 MB.

nginx sets none of HSTS, CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `server_tokens off`. Plain `:8080` only, no TLS, no prod compose overlay. CORS allowlist has only `localhost`/`127.0.0.1` with a `// Add prod hostnames here` placeholder — a deployed frontend will be blocked.

### S7. Unauthenticated public write endpoint
`reservation/index.js:130` — `POST /api/public/reservations/:confirmationNumber/notes`: anyone with a confirmation number can append notes. `:108` returns guest details with no second factor (no surname/email check). `POST /api/public/reservations` (`:37`) can create 200 unauthenticated PENDING bookings per minute with no captcha or email verification. The confirmation number itself is strong (`crypto.randomBytes(6)`), so enumeration is impractical — that part is fine.

---

## HIGH — the 3D room

### D1. The auto-fit scaler is mathematically wrong (single highest-impact defect)
`task3d.jsx:89-103`:
```js
if (fitWidth) s.scale.setScalar(fitWidth / (Math.max(size.x, size.z) || 1));
```
Uniform scale keyed off the **horizontal max only**. Your GLBs are Meshy-AI image-to-3D exports with arbitrary non-metric proportions, so height becomes whatever the native aspect ratio happens to be. Measured:

| Model | native x,y,z | fitWidth | **rendered** | verdict |
|---|---|---|---|---|
| King Platform Bed | 1.188, 0.5, 1.181 | 2.4 | **2.40, 1.01, 2.39** | perfect square, 1 m tall; real king is 1.93 × 2.03 |
| City Skyline Backdrop | 0.464, 0.3, 0.021 | 7.0 | **7.0, 4.53, 0.32** | spans y −0.57…3.96 in a 3 m room |
| City Skyline Backdrop (2nd) | same | 4.2 | **4.2, 2.72, 0.19** | different height from the 1st → the corner window wrap doesn't line up |
| Vertical Wood Slate Wall | 0.987, 1.2, 0.105 | 2.6 | **2.60, 3.16, 0.28** | clips ceiling *and* floor |
| Framed Landscape Art | — | 0.9 | **0.90, 1.87, 0.04** | a 1.87 m-tall "landscape" painting |
| Bathroom Vanity Double | 1.263, 1.5, 0.444 | 2.0 | **2.00, 2.37, 0.70** | 2.37 m tall vanity |
| Bedroom Area Rug | 0.676, **0.9**, 0.107 | 3.6 | **3.60, 4.79, 0.57** | a rug 4.8 m tall |

**Fix** — `task3d.jsx:95`, add an optional `fitHeight` and prefer it:
```js
const s3 = fitHeight ? fitHeight / (size.y || 1)
         : fitWidth  ? fitWidth  / (Math.max(size.x, size.z) || 1) : 1;
s.scale.setScalar(s3);
```
Then give real heights in `MODEL_CFG` (`RoomFreeRoam.jsx:26-38`): `bed {h:0.55}`, `city {h:2.6}`, `slatwall {h:2.4}`, `shower {h:2.1}`, `art {h:0.6}`, `vanity {h:0.85}`, `wardrobe {h:2.3}`, rugs `{h:0.02}`.

Also: `MODEL_CFG.nightstand = { w: 2.6 }` (`RoomFreeRoam.jsx:27`) — a **2.6 m wide nightstand**. Almost certainly a typo for `0.6`, and it's the default the editor palette hands you.

### D2. Three of four tiers contain zero GLBs

| Tier | GLB fixtures | primitive fixtures |
|---|---|---|
| Standard | **0** | 20 |
| Deluxe | **0** | 26 |
| Suite | **0** | 32 |
| Presidential | 22 | 13 |

Standard/Deluxe/Suite are entirely `RoundedBox` with flat hex colors. Notable: every rug in every tier is a grey-blue `planeGeometry` (`color="#9fb0bf"`) while `Bedroom Area Rug.glb` / `Living Room Area Rug.glb` / `Study Area Rug.glb` sit unused. The `coffee` table is a slab at y=0.22 **with no legs**, floating 13 cm off the floor. The `dining` table top sits at y 0.41–0.49 — a 45 cm dining table, the same height as its own chairs' seats. `mirror` is a solid `#cfe6f5` box with no reflection. ~13 registered GLBs are never placed in any layout.

### D3. No environment map — everything is matte plastic and metals render black
`<Environment>` / `envMap` / `useEnvironment` / `<Sky>` / `MeshReflectorMaterial` → **0 hits repo-wide**. Zero texture maps anywhere (no `useTexture`, no `map=`, no `normalMap`, no `roughnessMap`). Every surface is a flat hex constant.

`meshStandardMaterial` with no environment gets **no specular reflection at all**. And where `metalness > 0` is set — WallArt rings at `0.85`, faucets and rails at `0.6–0.7` — metals have no diffuse term, so **your gold and chrome accents render as near-black smudges**.

### D4. Lighting is ~45% direction-free, and shadows land only on the floor
`RoomFreeRoam.jsx:235-237`: `ambientLight 0.66` + `hemisphereLight 0.4` = **1.06 of flat fill** vs `1.3` directional. Form-defining shading is washed out — this is the main reason it reads flat.

The floor has `receiveShadow` (`:238`); the ceiling and all four walls have **neither `castShadow` nor `receiveShadow`** (`:239-243`). The sun passes straight through the ceiling and no wall ever shows a shadow. An interior with zero shadow on any vertical surface always looks fake. No `shadow-bias`/`shadow-normalBias` either → acne and peter-panning.

`<ContactShadows>` is present but at `scale = max(W,L)+4` = **19 m at drei's default 512 resolution** = 3.7 cm/texel with `blur 2.6` — grey mush, not contact shadows. It's also a plane at y=0.02, *above* the rug planes at y=0.012.

### D5. Arrangement math — nothing is against anything
Room dims: Standard 6.4 × 8, Deluxe 7.6 × 9.5, Suite 9 × 12, Presidential 12 × 15. Ceiling is 3 m in all four (no tier sets `h`).

**Gaps:**
- Standard bed headboard back face at z −3.71, back wall at −4.0 → **29 cm gap**
- Standard nightstands → **45 cm off the wall**
- Presidential bed vs its partition → **29 cm gap**; rendered model is 2.39 deep vs `box: 2.6` and 2.40 wide vs `box: 2.0`, so **collision is 40 cm narrower than the visual** — you walk into the mattress
- Presidential twin vanity → **52 cm gap**, while its wall mirror is flush. Vanity and mirror half a metre apart
- Presidential sofa → **39 cm gap** from the accent wall it's staged against

**Actual intersections:**
- Presidential `deckTub` **clips 14 cm into the bathroom wall**
- Presidential `toilet` **passes through the bathroom wall**
- Standard `tub` overlaps the bath back wall by 3 cm
- Standard `tv` cabinet **clips the door**

**Wrong facings:**
- **The vanity faces the wall.** `renderFix` case `'vanity'` puts the basin at local z +0.02, so the front is +z; every layout places it unrotated at the +z front wall. Its built-in mirror hangs in mid-air 50 cm out on the room side — then the layout adds a *second* mirror. Two mirrors per vanity.
- **The wardrobe is 90° out.** Geometry is 1.2 (x) × 0.6 (z); against the left wall it protrudes **1.2 m into the room on a 0.6 m contact face**, doors pointing sideways. `FOOTPRINTS.wardrobe` agrees with the wrong visual, so collision hides the error.

**Other:**
- Duplicate lamps at identical coordinates (`roomLayouts.js:97`+`:109`, `:149`+`:164`) → z-fighting plus doubled `pointLight`
- Presidential `minibar` station has **no wet bar fixture** — the interaction ring sits on bare floor. Same for the `balcony` station (no drape) and there's no `tv` at all
- `slatwall` has `wall:true` with no `box`, so it's a 3.16 m freestanding screen mid-room the player **walks straight through**
- No A/C vent geometry anywhere, though every tier has an "ac / wall vent" station
- Pendants top out at y=2.8 against a 3.0 m ceiling → 20 cm of nothing above the cord

### D6. The layout validator gives false confidence
`scripts/check-room-layouts.mjs` prints `✅ ALL TIERS CLEAN` on the room described above. It only checks **2D gameplay footprints** — it never looks at Y, height, model scale, or wall clipping. That's why all of D5 survived. It also has a `name === 'Presidential' ? null` adjacency exemption at `:117`, which is what let the wet-bar-with-no-wet-bar through.

### D7. 440 MB of uncompressed GLB in one room
Presidential pulls **440 MB across 18 unique GLBs**, `extensionsUsed: []` — no Draco, no meshopt, no KTX2. `Decorative Potted.glb` is **1,069,623 triangles** with a 9.9 MB JPEG. `King Platform Bed.glb` is 495,166 tris + 8.7 MB JPEG. Framerate is part of "looks decent."

### D8. `fov: 70` is too wide for interiors
`RoomFreeRoam.jsx:315`. Strong edge stretching; makes the room feel like a fisheye corridor. 55–58 is the norm. Also the drag-look fallback listens on bare `pointerdown` (`:197`), so **clicking a station ring also swings the camera**.

### D9. The editor doesn't show what the game shows
`RoomLayoutEditor.jsx:61-63` uses different light values *and* **omits the front wall and ceiling entirely**. You're tuning the room in a view that doesn't match the render.

---

## HIGH — mini-games

### G1. Four stations, one component
`extraTasks.jsx:164-167`:
```js
export const Turndown      = (p) => <ChecklistTask cfg={TURNDOWN} {...p} />;
export const AmenitySetup  = (p) => <ChecklistTask cfg={AMENITY}  {...p} />;
export const Dining        = (p) => <ChecklistTask cfg={DINING}   {...p} />;
export const Balcony       = (p) => <ChecklistTask cfg={BALCONY}  {...p} />;
```
Click buttons in a grid, once each. No scene at all — no 3D, no SVG, no drag. Completion is **order-insensitive** (`:26` `goodIds.every(id => nd.includes(id))`), so "perform turndown in order" and "lay a proper place setting" don't actually test sequence. On Presidential these are **4 of 13 stations (31%)** and all four feel identical.

### G2. "13 stations" is really 7 mechanics
Station counts: Standard 7, Deluxe 9, Suite 12, Presidential 13. But Presidential's 13 resolve to **7 distinct components + 1 reused 4× + 2 aliases** (`bath`/`bath2` → same, `vacuum`/`livingvac` → same). Across the whole app: 10 components, **6 genuinely distinct interaction patterns**.

### G3. Vacuuming is unscoreable
`Vacuum3D.jsx` is 50 lines. Ten individual clicks, no drag, no tool, no SOP binder. `:32` **hardcodes `procedure: GOOD`** — the "Thoroughness" competency literally cannot be scored. You cannot fail. The 2D twin is worse: `onPointerMove={sweep}` with no `e.buttons` check (`CleaningGame.jsx:278`) means **hovering the mouse across the carpet clears it without clicking**.

### G4. Two of three top-level games discard results

| Path | Persisted? |
|---|---|
| Cleaning game, completed | ✅ `Housekeeping.jsx:337` → `api.post('/api/training/results')` |
| Cleaning game, **mid-shift** | ❌ `useState` in `RoomFreeRoam.jsx:282` — reload or "Leave shift" loses everything |
| Guest Services | ❌ `Housekeeping.jsx:350` — toast only |
| Lost & Found | ❌ `Housekeeping.jsx:358` — toast only |
| Layout editor | ❌ `localStorage` only |

**Zero API calls exist anywhere in `web/src/sim/`.** A student who closes the tab midway through a 13-station Presidential suite loses the entire shift. `Training.jsx`'s competency table can never reflect guest-service or lost-&-found skill.

### G5. The timer is rendered but never used
`elapsed` ticks at `CleaningGame.jsx:737` and displays at `:767`, but never enters `items`, `computeVerdict`, or the POST. `RoomFreeRoam` — the version students actually play — has **no timer at all**.

### G6. No activity has a fail state
Every task loops until correct. `computeVerdict` can only reach its lower tones via *skipping*. `ISSUES` is effectively optional.

### G7. Lost & Found is graded by luck
`LostFoundGame.jsx:59`:
```js
procedure: found ? (searched.length <= 2 ? GOOD : ISSUES) : SKIPPED
```
The hiding spot is uniformly random across 5 hotspots with no clues, so "Located the item" is a **2-in-5 coin flip**, not a skill measurement.

### G8. Guest Services has a scoring bug and dead code
- `GuestRequestGame.jsx:69` → `if (o.ok) { out.current.door = GOOD; }` **overwrites** a recorded `ISSUES`, so a privacy violation is erased on retry. This makes the ISSUES note at `:127` unreachable dead text. Compare `:83`, which correctly uses `out.current.last || GOOD`.
- `:86` → `setPhase(o.ok ? 'objection' : 'objection')` — both branches identical. An intended divergence was never written.

### G9. Pointer-lock fights station clicks
`RoomFreeRoam.jsx:196` calls `el.requestPointerLock()` on click, while station rings are separately clickable at `:263`. Once locked, r3f raycasts from the last-known unlocked cursor position — so the on-screen hint *"drag or click to look · walk up to a glowing marker"* (`:325`) describes an interaction that doesn't reliably work. `E` is the only dependable path, and its prompt only shows within 2.4 m.

Related: Presidential `bath` `[-3.5,-5.6]` and `bath2` `[-4.3,-4.0]` are 1.8 m apart, inside the 2.4 m proximity radius, so only the nearer is ever promptable from between them.

### G10. ~490 lines of unreachable duplicate code
The entire station-hub UI plus the 2D `Vacuuming`, `Minibar`, `Thermostat`, `Linen`, `Inspection` (`CleaningGame.jsx:204-692`, `:759-813`) render **only** when `supportsWebGL()` is false. On any normal browser this is dead. It's also where the hover-to-vacuum bug lives, and it silently hides 4 activities from no-WebGL users (they get 7 tasks and never see turndown/amenity/dining/balcony).

### G11. `Bathroom3D` model bugs
`:90` → `<Model modelKey="sink" .../>` — `"sink"` is **not** a key in `MODELS` (it's `vanity`), so the sink is permanently a procedural box even though `Bathroom Vanity Double.glb` exists. `<Model modelKey="tub">` has no `fitWidth`, so the tub renders at raw GLB scale. `useMemo` imported at `:1`, never used.

### G12. The Training page has no launcher
`Training.jsx` is a read-only results table with no launch button, yet tells the student *"Run the sim from the Housekeeping screen to add more"* (`:33`). Dead-end UX for the page named "Training" in the nav.

---

## MEDIUM — correctness

### M1. Night audit reports and posts against the wrong calendar day
`audit.routes.js:32-35`:
```js
function dayKey(d) { const x = new Date(d); return new Date(x.getFullYear(), x.getMonth(), x.getDate()); }
```
This builds **local** midnight — 2026-07-29 00:00 +08:00 = `2026-07-28T16:00:00Z`. That value is then `toISOString()`d:

- `:190` → `description: 'Room charge for ${date.toISOString().slice(0,10)}'` — **guest-visible folio line shows the wrong date**
- `:234-245` → `dateStr` feeds `/api/arrivals?date=`, `/api/departures?date=`, `/api/folios/daily-totals?date=` — **EOD counts and revenue totals are for the previous business day**
- `:95-96` filters `businessDate.gte = new Date(from)` (UTC midnight) against local-midnight rows, so `?from=2026-07-29` **excludes** the 2026-07-29 business day

Your frontend already documents this exact hazard and avoids it (`web/src/lib/date.js:3-7`: *"Using `new Date(...).toISOString().slice(0, 10)` to build a day key is a silent bug"*). The backend does not. Same pattern in `inventory/src/index.js:47`, `inventory.routes.js:41,83`, `reservation.routes.js:176-177`, `folio.routes.js:785`.

Worse, the two services use **different conventions**: reservation stores `new Date(checkIn)` (UTC midnight) while audit stores local midnight — cross-service date comparisons are 8 h out of phase.

The Philippines has no DST, so this is a fixed +08:00 offset bug, not a DST bug. Frontend date handling is correct throughout.

### M2. All timestamps are `timestamp(3)` without time zone
`@db.Timestamptz` / `@db.Date` → 0 hits across all 9 schemas. Date-only business concepts (`businessDate`, `checkIn`, `checkOut`, `InventoryHold.date`) are stored as instants. Correctness depends entirely on `TZ=Asia/Manila` being present in every container and on never mixing conventions — which M1 shows it does.

### M3. PDFs render timestamps in UTC
`folio.routes.js:759,785`. A folio opened at 21:00 Manila prints as the previous day 13:00 on the guest's statement.

### M4. Night audit marks no-shows a day late
`audit.routes.js:211` → `new Date(r.checkIn) < date`. Strictly less-than, so a CONFIRMED reservation whose check-in *is* the business date is never no-showed by that day's audit — it's caught the following night.

### M5. Folio number collisions
`folio.routes.js:39-41` → `` `F-${Date.now()}-${Math.floor(Math.random()*1000)}` `` on a `@unique` column. Two folios in the same millisecond have a 1-in-1000 collision, surfacing as a 500. The reservation service does this correctly with `crypto.randomBytes`.

### M6. Email silently fails in production
`services/_shared/notifier.js` is a hand-rolled SMTP socket client that documents itself as dev-only (`:5`). `nodemailer` is in no `package.json`. Production email works only if an SMTP relay accepting unauthenticated plaintext on port 1025 is reachable.

### M7. MinIO is provisioned but entirely unused
`docker-compose.yml:45-63` runs MinIO with a persistent volume and a default root credential. `minio` / `aws-sdk` / `S3Client` → 0 hits across all services. Dead infrastructure with a known password.

---

## MEDIUM — CI, build, and repo hygiene

### C1. The CI lint job cannot pass
`.github/workflows/ci.yml:19-22`. Three independent failures:
1. `npm i -D --no-save eslint prettier` installs **ESLint 9**, which ignores `.eslintrc.json` and requires `eslint.config.js` (absent) → the step errors before linting anything.
2. `web/src/sim/models/` contains **34 minified Vite build chunks** (e.g. `index-BW7Vpc10.js` at 406 KB, `ContactShadows-BVgVpoc-.js` at 828 KB). `.prettierignore` only excludes `**/dist/**`, so these get linted.
3. Every service has an unused `const cors = require('cors')` (`services/*/src/index.js:2`, with `// cors handled by gateway` on the next line). `no-unused-vars` is `warn` and CI uses `--max-warnings=0` → hard failure ×9.

`compose-smoke` will also fail on a clean runner — `docker compose build` has to copy the ~2 GB `web/src` context.

### C2. The test matrix is a no-op for 8 of 9 services
Two test files exist: `auth/src/middleware/auth.test.js` (77 lines, genuinely useful) and `reservation/src/routes/reservation.test.js` (156 lines). Only `auth/package.json` defines `"test"`, so `npm test --if-present` (`ci.yml:56`) silently succeeds for the other 8 — **including the reservation test that exists but is never invoked**.

Zero tests for money math (`_shared/policies.js` — pure functions, trivially testable), the night audit, folio balance computation, or the frontend.

### C3. 2.0 GB of duplicated binaries inside `web/src`
`web/src/sim/models` is **2.0 GB** / 119 entries: **82 `.glb`** but only ~41 unique — every asset exists twice, original plus Vite content-hashed copy (`Custom Wooden Wardrobe.glb` **and** `-B2b_erID.glb`, both 44,757,916 bytes; `Stacked Folded Towel.glb` / `-BRodqxFm.glb`, 62.3 MB each; ~30 more). Plus 34 hashed JS chunks from **two separate builds** (mtimes Jun 21 and Jul 23).

Nothing imports any of the `.js` files. Someone ran `vite build` with `outDir` pointed into `src/sim/models/`, twice. Not covered by any ignore rule.

### C4. `web/dist` is stale *and* broken
`web/dist/index.html:6` references `/assets/index-BW7Vpc10.js`, but `dist` contains only 4 files: `index.html`, one CSS, and two `.DS_Store`. The referenced chunk is sitting in `web/src/sim/models/`. Serving this `dist` yields a blank page.

### C5. Dockerfiles: single-stage, root, no `NODE_ENV`, no lockfiles
All 10 Dockerfiles are 8 lines of `FROM node:20-alpine` → `npm install` → `COPY . .`. `USER` → 0 hits, so **every container runs as root**. `NODE_ENV` is never set anywhere — which is why the weak-JWT-secret hard-fail in `middleware/auth.js:7` can never fire, pino stays at `debug`, and Express keeps dev-mode behaviour. Only `services/auth` has a `package-lock.json`; the other 8 resolve unpinned transitive deps on every build. No `.dockerignore` anywhere.

### C6. No README
`find . -maxdepth 2 -iname "*.md"` → nothing. No setup, run, or deploy instructions. For a capstone handover this is a real gap.

Also in the tree: `InnSight_FINAL_Corrected.docx` (12.4 MB), `InnSight_Audit_Report.docx`, and `Cloudbed PMS Guide/` holding **202 MB of 13 YouTube-ripped .mp4 files**.

---

## What's actually well built

Worth saying, because it's a lot, and it means the gaps above are fixable rather than foundational:

- **Money handling is correct.** Integer cents throughout, `BigInt` columns, `BigInt` arithmetic in balance computation, `Math.round` on every percentage in `_shared/policies.js`, and a `BigInt.prototype.toJSON` shim in exactly the 5 services that have BigInt columns. No floats anywhere.
- **No SQL injection risk.** All access is Prisma with structured `where` objects; **zero** `$queryRaw` / `$executeRaw` / `*Unsafe` calls repo-wide.
- **Login brute-force protection is genuinely good** — two layers: account lockout after 5 failures (`auth.routes.js:13,43-50`) plus a dedicated nginx zone for `/api/auth/login`. Username enumeration is deliberately handled (account status only revealed *after* a correct password, with an explanatory comment).
- **No stack-trace leakage.** Every catch logs `err.message` and returns a generic error; the global handler never sends detail to the client; pino redacts `authorization`, `password`, `token`, `cardNumber`, `cvv`.
- **Graceful shutdown is properly implemented** — SIGTERM/SIGINT, awaited `server.close()` so in-flight requests drain, cleanup callbacks, 10 s `unref`'d hard-exit timer.
- **Health checks are thorough** — `/health` on all 9 services plus the gateway, compose `healthcheck` gating with `condition: service_healthy`, and a roll-up endpoint with per-target 2 s `AbortController` timeouts reporting up/degraded/down.
- **The SSE reconnect logic in `useLiveEvents.js` is careful** — exponential backoff capped at 30 s, and it re-reads the token from `localStorage` on each attempt, which correctly avoids the native-EventSource 401 loop.
- **The idempotency middleware itself is well designed** — Redis `SET NX EX` lock, 24 h replay cache, keys namespaced by service + authenticated user + method/path so they can't be replayed across users or routes, fail-open on Redis outage. (It's only the client-side key generation that defeats it.)
- **Observability** — pino structured logs, request-id propagation from the gateway, `X-Request-Id` echoed back, Prometheus `/metrics` with route-pattern labels and an explicit `'unmatched'` bucket to bound cardinality.
- **Shared-code drift is guarded** — `scripts/check-shared.sh` byte-diffs `_shared/*.js` against every vendored copy, enforced in both the pre-commit hook and CI. Sensible answer to the per-service Docker build context constraint.
- **Frontend API base URL is correctly not hardcoded** — `import.meta.env.VITE_API_URL || ''`, relative same-origin by default, with a documented rationale.
- **Frontend date handling is correct** and documents the UTC pitfall the backend falls into.
- **CI structure is well designed** — lint, per-service test matrix with `fail-fast: false`, Vite build, compose smoke test polling `/health` for 60 s with log dump on failure. It just can't currently pass and has nothing to run.
- **`.env` hygiene** — no `.env` in the tree, `.env.example` documents every variable with `openssl rand -hex 32` instructions.
- **Public booking recomputes pricing server-side** and ignores client-supplied `totalEstimateCents` (`reservation/index.js:39-42`). Exactly right.
- **`RoundedBox radius={0.04}`** — the primitives do have bevels, which is the one thing carrying the boxy look.
- **`BedMaking3D.jsx` and `Bathroom3D.jsx` are genuinely good** — real 3D pointer-drag with an invisible raycast plane and hit-testing; real tool-state machine with a 1500 ms dwell gate that penalises wiping too early. These are the model the other eight activities should follow.

---

## Suggested order of work

**Phase 1 — correctness (do first; nothing else matters if bookings are wrong)**
1. Availability check + row lock + transaction in reservation create (B1)
2. Collapse the availability/hold decision into one database, or two-phase it (B2, B3)
3. Server-side validation on walk-in and check-in room assignment (H8)
4. Fix the night-audit day key; add a shared `localDay()` helper to `_shared/` (M1)
5. Add indexes on every FK and list-endpoint filter (H5)

**Phase 2 — deployability**
6. Multi-stage `web/Dockerfile` + `location /` at the gateway (B4)
7. Remove all secret defaults; move seeding out of `CMD`; set `NODE_ENV=production` (B5, C5)
8. Baseline Prisma migrations; switch to `migrate deploy` (B6)
9. Delete `web/src/sim/models/*.js` and every hashed `.glb`; move assets to `public/`; add `.dockerignore` (C3, C4)
10. Fix per-user rate limiting — pass `X-Forwarded-For` through Vite/nginx, or move limiting into the services (H1)
11. Channel-filter `useLiveRefresh` per page so a minibar charge stops reloading the Dashboard (H2)
12. Shared subscriber for SSE instead of one Redis connection per tab (H3)
13. `connection_limit` on every `DATABASE_URL`; consolidate to one `PrismaClient` per service (H4)

**Phase 3 — the 3D room (highest visual return per hour)**
14. `fitHeight` in the scaler + real heights in `MODEL_CFG` + fix `nightstand: 2.6` → `0.6` (D1)
15. `<Environment preset="apartment">` + ACES tone mapping, then drop ambient to 0.18 and hemi to 0.15 (D3, D4)
16. `receiveShadow` on walls and ceiling; `shadow-normalBias`; tighten the shadow frustum to room size; `ContactShadows resolution={1024}` (D4)
17. `fov: 70` → `58` (D8)
18. Push furniture onto its walls; un-clip the Presidential bathroom; rotate the vanities and wardrobes; delete the duplicate lamps and redundant mirrors (D5)
19. Convert Standard/Deluxe/Suite from `type:` to `model:` — **after** step 14 (D2)
20. Extend `check-room-layouts.mjs` to validate Y, height, model-vs-box footprint, and wall proximity (D6)
21. `gltf-transform optimize --texture-compress webp --texture-size 1024` + meshopt: 440 MB → ~20 MB (D7)

**Phase 4 — the mini-games**
22. Persist Guest Services and Lost & Found results; autosave in-progress shift state (G4)
23. Give the four `ChecklistTask` stations real distinct scenes, starting with Dining as drag-to-place (G1)
24. Rebuild Vacuuming as a held-drag coverage mechanic with real scoring (G3)
25. Feed the timer into scoring; add par times; add slip budgets so `ISSUES` is earned (G5, G6)
26. Fix the `door = GOOD` overwrite and the identical-branch ternary in Guest Services (G8)
27. Re-grade Lost & Found on sweep order rather than luck (G7)
28. Resolve the pointer-lock/ring-click conflict (G9)
29. Delete the 2D fallback fork; replace with a WebGL-required notice (G10)
30. Give `Training.jsx` a launcher and an activity catalogue (G12)

**Phase 5 — security hardening**
31. Default-deny authorization; wire up the unused `requirePermission` (S3)
32. Short-lived SSE tickets instead of session JWTs in URLs; mask query strings in nginx logs (S2)
33. Asymmetric JWT signing; separate service credentials (S1)
34. Refresh tokens + Redis denylist so logout and user-disable actually revoke (S4)
35. Fix the three broken PDF downloads (blob via axios) (S5)
36. Add `zod` validation, `helmet`, security headers, TLS, a prod compose overlay; stop publishing raw service ports (S6, H13)
37. `AbortSignal.timeout()` on all inter-service calls; `unhandledRejection` handlers (H11, H12)
38. Fix the CI lint job so the pipeline is green-verifiable; add `"test"` scripts to all 9 services (C1, C2)
39. Write a README (C6)
