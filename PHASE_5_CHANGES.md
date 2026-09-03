# Phase 5 — Security hardening, CI, README

Closes S2, S3, S4, S5, H11, H12, H13, C1, C2, C6, and the achievable part of S1 and
S6. **240 unit tests pass** (was 220), and **the CI lint job passes for the first
time**.

---

## ⚠️ One new required secret

`SERVICE_JWT_SECRET` is now required. Compose refuses to start without it.

```bash
bash scripts/gen-env.sh --force     # regenerates .env including the new key
```

Or add it by hand: `SERVICE_JWT_SECRET=$(openssl rand -hex 32)`. It **must differ**
from `JWT_SECRET` — in production the services hard-fail if they match.

---

## Financial and PII reads were open to everyone (S3)

Authorization is per-route middleware, so a route is unprotected **by default**. The
writes were all guarded; the reads were not. Any authenticated account — including a
HOUSEKEEPING trainee — could read every folio, every guest profile with its contacts
and consents, daily revenue totals, and printable statements. `requirePermission`
existed and was never called anywhere.

**37 open routes now carry an explicit role guard**, expressed as named groups
(`ROLE_GROUPS.DESK_AUDIT`, `MGMT_AUDIT`, `OPS_READ`, …) so a route's audience is
legible at the call site. All 104 business routes are guarded.

Verified live against a real HOUSEKEEPING account:

| Route | Before | After |
|---|---|---|
| `/api/folios` | 200 | **403** |
| `/api/folios/daily-totals` | 200 | **403** |
| `/api/guests/search` | 200 | **403** |
| `/api/reservations` | 200 | **403** |
| `/api/stays`, `/api/promo-codes` | 200 | **403** |
| `/api/rooms`, `/api/arrivals`, `/api/reports/room-status` | 200 | **200** (still needed) |

**And it's now enforced, not just fixed.** Express can't do a runtime "deny anything
unchecked" — once a handler responds, no later middleware runs. So each service has an
`authz.test.js` that walks its own router stack and fails if any route lacks a
recognised guard (`services/_shared/authzAudit.js`). A new unguarded route fails CI
instead of shipping open. That also required naming the guard middleware
(`roleGuard` / `permissionGuard`) so it's identifiable by function name.

## Logout was a no-op (S4)

`POST /api/auth/logout` published an event and returned `{success:true}`. That was
all. The JWT stayed valid for its full 12-hour TTL, so "log out" on a shared
front-desk machine left a working credential behind. Disabling an account had the
same problem, and because roles are baked into the token a role change — including a
*demotion* — took up to 12 hours to apply.

Two Redis-backed mechanisms in `_shared/tokenRevocation.js`:

- **Per-token denylist** for logout. Tokens now carry a `jti`; the denylist entry's
  TTL matches the token's remaining life, so it can never grow without bound.
- **Per-user epoch** for anything that should kill every session at once: disable,
  password change, password reset, role change. One write invalidates all outstanding
  tokens, including ones the system never saw.

Verified live: `/api/auth/me` → 200, logout, same token → **401**.

Fail-open on a Redis outage, deliberately and with the reasoning written down: a
Redis blip locking every member of staff out mid-shift is worse for a hotel than a
revoked token surviving a few more minutes. It mirrors the stance the idempotency
middleware already took.

## 12-hour bearer tokens were written to the access log (S2)

SSE auth was `?token=<session JWT>`, and nginx logs `"$request"` — which includes the
query string. Every live-dashboard connection persisted a valid 12-hour credential to
`/var/log/nginx/access.log`, browser history, and any intermediate proxy.

- New `POST /api/events/ticket` returns a **single-use, 30-second** opaque ticket
  (Redis `GETDEL`, so replay fails even inside the window). Only the ticket goes in
  the URL.
- The nginx log format is now `"$request_method $uri $server_protocol"` — the path
  without the query string.
- A raw JWT is only accepted if `ALLOW_SSE_JWT=true`, off by default.

Verified live: raw JWT in the URL → **401**; first ticket use → 200; second use of
the same ticket → **401**. Access log shows `GET /api/events` with no query string.

## All three print/PDF features were broken (S5)

`Folios`, `Arrivals` and `ReservationDetail` all used `window.open(...)`, a plain
browser navigation that sends no `Authorization` header — the token is attached only
by the axios interceptor. Both endpoints sit behind `verifyToken`, so every one of
them opened a tab reading `{"error":"Missing bearer token."}`.

New `web/src/lib/download.js` fetches through axios as a blob. It also sniffs a JSON
error body rather than cheerfully saving `{"error":…}` as a PDF, and falls back to a
download if the pop-up is blocked.

## Machine tokens are a separate credential — but still symmetric (S1, partial)

folio, audit and reports each minted their own admin token **with the same secret as
human sessions**:

```js
jwt.sign({ sub: 'system.folio', roles: ['ADMIN'] }, JWT_SECRET, { expiresIn: '2m' })
```

So compromising any one service yielded a forgeable login for any user, and nothing
distinguished a machine caller from a person.

- One minter, `signServiceToken()`, signing with **`SERVICE_JWT_SECRET`** and setting
  `svc: true`.
- **`jwt.verify` now pins algorithm, issuer and audience.** It previously pinned
  none of them — the algorithm-confusion footgun.
- Service roles narrowed: folio asserted blanket `ADMIN`, now `MANAGER` with the two
  permissions it actually uses.
- `_shared/serviceCall.js` (which also signed independently) routes through the same
  minter. **This one mattered:** without it, pinning the issuer would have broken
  reservation→inventory hold acquisition — the double-booking protection.

**Not done, and not pretended otherwise:** this is still symmetric. Every service
holds `SERVICE_JWT_SECRET`, so a compromised service can still mint a *machine*
token — it just cannot mint a human session. The complete fix is RS256/EdDSA with
auth holding the private key and folio/audit/reports *requesting* tokens instead of
minting them. That needs a token-issuing endpoint plus caching in every caller, and
is left as follow-up rather than half-implemented.

## Timeouts and crash handlers (H11, H12)

Node's global `fetch` has no default timeout, and there were **zero**
`unhandledRejection` / `uncaughtException` handlers repo-wide — under Node 20 an
unhandled rejection kills the process, which with `restart: unless-stopped` is a
silent crash-loop.

- Every remaining inter-service `fetch` has `AbortSignal.timeout()` — audit, reports
  and folio's two call sites (reservation and stay were done in Phase 1). This
  matters most for the night audit, which makes several sequential cross-service
  calls per in-house stay.
- `gracefulShutdown` now installs crash handlers that **log the reason**, drain
  in-flight requests, and exit **non-zero** so an orchestrator can tell a fault from
  an intentional stop.

Still open: the night audit's fan-out is unbatched (3 calls per stay, 300+ at 100
occupied rooms). Bounded now, but still slow.

## Services no longer publish their ports (H13)

Every service published 3005–3013 to the host, so `curl localhost:3010/api/auth/login`
bypassed the gateway entirely — and with it the login rate limit, the CORS allowlist
and the security headers.

The base compose is now **closed by default** (`expose`, not `ports`), with an opt-in
overlay for debugging:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

It has to be this way round: Compose merges `ports` by *appending*, so an overlay can
add published ports but never remove them. The safe configuration must be the base.

Verified: `:3010`, `:3007`, `:3005` all refuse connections; the app works through
`:8080`.

## Security headers (S6, partial)

nginx set **none** of HSTS, CSP, `X-Frame-Options`, `X-Content-Type-Options`,
`Referrer-Policy`. Now present and verified on live responses:

`Content-Security-Policy` (script-src strict; `unsafe-inline` for styles only, since
the app uses inline `style=` attributes), `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Cross-Origin-Opener-Policy`, `Permissions-Policy`.

### The CSP broke every 3D model (found and fixed 2026-07-30)

The header set above was correct by security-header standards and **silently broke the
entire 3D layer** — the training sim and the layout editor both rendered an empty room.
Two separate directives were at fault, and neither failure names the CSP as the cause
in any obvious place:

| Directive | Why it's required | Symptom without it |
|---|---|---|
| `script-src … 'wasm-unsafe-eval'` | Every shipped `.glb` is `EXT_meshopt_compression`; the meshopt decoder is a WASM module instantiated at runtime | `WebAssembly.instantiate(): … violates … Content Security Policy`. **No geometry at all** |
| `connect-src 'self' blob:` | `GLTFLoader` unpacks each embedded WebP texture into a Blob and loads it through `ImageBitmapLoader`, which uses `fetch()` | `THREE.GLTFLoader: Couldn't load texture blob:…`. Geometry loads, **untextured** |

The second one is the trap: `img-src blob:` was already present and does **not** cover
it, because the blob is fetched, not loaded as an `<img>`. `'wasm-unsafe-eval'` permits
WASM compilation only — it is not `'unsafe-eval'` and does not allow `eval()` of
strings.

This is Phase 5 undoing Phase 3's work, and it was invisible: the model files still
served with HTTP 200 (CI asserted exactly that), the build passed, no route 500'd. It
only showed up by opening the app and looking at the room.

**Guarded now**: the smoke job asserts both directives against the live response
header. Serving a `.glb` is not the same as being allowed to decode it, so the check
had to be about the header, not the file.

Verified after the fix: the Presidential layout renders in full in the editor (bed,
desk, city backdrop, bathroom, textured floor, station rings), and a Standard turnover
shift renders in the sim, with zero console errors on either.

**The rest of the CSP was then audited, and it is clean.** A `securitypolicyviolation`
listener across 19 pages as ADMIN — dashboard, reservations, new reservation, calendar,
arrivals, rooms, housekeeping, guests, folios, reports, revenue, night audit, amenities,
users, walk-in, booking, training, room layouts, health — recorded **zero** violations.
Nothing in the app trips the remaining directives: there are no external hosts at all
(no CDN or Google fonts, no remote images), no Web Workers, no `<audio>`/`<video>`, no
iframes, and no `eval`/`new Function`. Asset content types are all correct
(`application/javascript`, `text/css`, `model/gltf-binary`), so `nosniff` doesn't bite.

One directive is worth knowing about: **`object-src 'none'` is enforced and does block
an embedded PDF** — deliberately triggering an `<embed type="application/pdf" src="blob:…">`
raises a violation. Nothing in the app uses `<embed>`/`<object>`, and `download.js`
hands PDFs over as a top-level `window.open(blob:)`, which `object-src` does not govern,
so the print features are unaffected. It is simply the first thing to suspect if a PDF
tab ever opens blank. Not verified end-to-end: the rendered PDF *tab*, because the
automated browser blocks pop-ups (not the CSP) — the fetch itself returns 200
`application/pdf`, and `download.js` falls back to a save when a pop-up is blocked.

**HSTS is written but commented out on purpose.** This stack listens on plain
`:8080`; sending `Strict-Transport-Security` over http pins browsers to an https
origin that doesn't exist and locks users out. Uncomment it the moment TLS
terminates at the gateway.

**Not done:** TLS itself, and a schema-validation library (`zod`). Validation is
still ad-hoc truthiness checks, so a malformed enum can yield a 500 where a 400
belongs. There is no SQL injection risk — all access is Prisma with structured
`where` objects and zero raw SQL — so this is an error-quality issue, not an
exposure. Adding zod means a dependency plus a rewrite of validation in 104 route
handlers; it is honestly out of scope for this pass.

## The CI lint job passes (C1, C2)

It had never passed. Three independent causes, all fixed:

1. **ESLint had no React plugin**, so every JSX identifier read as an unused
   variable — ~240 problems that were almost entirely noise. Added
   `eslint-plugin-react` + `eslint-plugin-react-hooks`, and moved the config to
   `.eslintrc.js` so the rule choices can carry their reasoning (JSON can't hold
   comments, and several of these look like silenced warnings but aren't —
   `react-three-fiber` props, and effect deps this codebase deliberately controls).
2. **Prettier failed on 164 files.** Formatted the repo. `check-shared.sh` still
   passes, because identical input formats identically.
3. **29 genuinely-unused variables** — fixed, not silenced: dead `jwt`/`JWT_SECRET`
   imports left over from routing service tokens through the shared minter were
   deleted, and unused parameters prefixed with `_`.

Both gates now pass at `--max-warnings=0`. CI also gained the react plugins in its
install step — without them the job would go straight back to noise.

All 9 services declare a `test` script (C2), so `npm test` no longer silently
succeeds for 8 of them.

## README (C6)

`README.md` — quick start, layout, the vendoring rule, scripts, migrations,
architecture invariants that are easy to undo by accident, and an honest security
posture section listing what is *not* done.

---

## Verified

- **240/240 unit tests**, including 6 new ones on revocation and token pinning, and
  8 authz-audit tests.
- **`prettier --check` and `eslint --max-warnings=0` both exit 0.**
- **Against the live stack**: role split (403/200 table above); logout revoking a
  token; SSE tickets being single-use and raw JWTs rejected; nginx logging no query
  strings; security headers present; ports 3005/3007/3010 refusing connections; the
  night audit completing (which exercises the new service credentials across every
  cross-service call).
- `check-shared.sh`, `check-room-layouts.mjs`, and the web build all clean.

**A bug this pass caught in its own work:** pinning the JWT issuer broke three auth
tests that signed tokens without the pinned claims. Caught by re-running the suite,
not by the build — a reminder that `node --check` and a green build prove very little
here.

**Not verified:** the CI workflow itself (no push to GitHub from this environment);
behaviour under a Redis outage (the fail-open path is reasoned, not exercised); TLS,
because there is none.

---

## What remains open across the whole project

Nothing from the audit's five phases is unaddressed, but these were consciously
scoped out rather than completed:

| Finding | Status |
|---|---|
| S1 | Partial — machine/human keys split and claims pinned; asymmetric issuance not done |
| S6 | Partial — headers done; TLS and `zod` validation not done |
| S7 | Public booking endpoints still have no captcha or email verification |
| H10 | No cross-service referential integrity (nine databases, bare string keys) |
| H7 | Idempotency keys are still minted per HTTP request, not per user intent |
| M2, M3 | Timestamps are `timestamp(3)` without time zone; PDFs render UTC |
| M5 | Folio numbers still use `Date.now()` + random (1-in-1000 collision) |
| M6, M7 | Email is a dev-only SMTP client; MinIO is provisioned but unused |
| D9 | Layout editor's lighting doesn't match the game view |
| — | Night audit fan-out is unbatched; model decode is slow on first entry |
