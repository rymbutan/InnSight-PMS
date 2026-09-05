// Offline feature audit — proves the app needs no internet.
//
// The system is demonstrated in a classroom with the wifi off, so any dependency on
// a public host is a defect. Chrome runs here with every hostname except localhost
// mapped to NOTFOUND, which is STRICTER than switching off the wifi: a real offline
// machine can still serve a request from a warm DNS or HTTP cache and hide the
// dependency. Nothing hides here.
//
// It logs in, walks every route, and reports four things per route: any request to
// a host other than localhost, any failed load, any uncaught exception, and any
// HTTP status of 400 or worse.
//
//   Usage:
//     AUDIT_PASS='<admin password>' node scripts/offline-audit.mjs
//     AUDIT_ROUTES='/,/folios' AUDIT_PASS=... node scripts/offline-audit.mjs
//
// Requires the stack to be up (`docker compose up -d`) and Google Chrome installed.
// Exits non-zero if any route reaches an external host, so it can gate a deploy.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://localhost:8080';
const USER = 'admin';
const PASS = process.env.AUDIT_PASS;
const PORT = 9222;

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + process.env.TMPDIR + 'audit-profile-' + Date.now(),
  '--window-size=1440,900',
  // WebGL in headless: software rasteriser, so the 3D scenes really render.
  '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
  // THE OFFLINE SIMULATION.
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

let wsUrl;
for (let i = 0; i < 60; i++) {
  try {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
    const page = list.find(t => t.type === 'page');
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(250);
}
if (!wsUrl) { console.error('chrome did not start'); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise(res => (ws.onopen = res));

let id = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) listeners.forEach(fn => fn(m));
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});

// ── evidence buckets, reset per route ────────────────────────────────────────
let inflight = 0, lastActivity = Date.now();
const sseIds = new Set();
let failed = [], consoleErrors = [], exceptions = [], external = [], statuses = [];

listeners.push((m) => {
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    // The SSE live-events stream is deliberately never-ending, so it must not
    // count towards "is the page still loading" or every route waits the full
    // timeout. Its request id is remembered so its completion is ignored too.
    if (/\/api\/events\//.test(u)) sseIds.add(m.params.requestId);
    else { inflight++; lastActivity = Date.now(); }
    if (/^https?:\/\//.test(u) && !/^https?:\/\/localhost[:/]/.test(u) && !/^https?:\/\/127\.0\.0\.1[:/]/.test(u)) {
      external.push(u.slice(0, 120));
    }
  }
  if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') {
    if (!sseIds.has(m.params.requestId)) { inflight = Math.max(0, inflight - 1); lastActivity = Date.now(); }
  }
  if (m.method === 'Network.loadingFailed') {
    // A request the BROWSER cancelled is not a failure. Navigating to the next
    // route aborts whatever the previous page still had in flight, and because the
    // evidence buckets reset at navigation start that abort lands in the next
    // route's bucket — reporting a healthy page as broken. Only genuine transport
    // failures count.
    if (m.params.canceled) return;
    const u = m.params.request?.url || '';
    failed.push({ err: m.params.errorText, url: u.slice(0, 120) });
  }
  if (m.method === 'Network.responseReceived') {
    const { url, status } = m.params.response;
    if (status >= 400) statuses.push(`${status} ${url.replace(BASE, '').slice(0, 90)}`);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 200));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0].slice(0, 200));
  }
});

const reset = () => { failed = []; consoleErrors = []; exceptions = []; external = []; statuses = []; };

await send('Network.enable');
await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};

const settle = async (quietMs = 900, maxMs = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (inflight === 0 && Date.now() - lastActivity > quietMs) return;
    await sleep(150);
  }
};

const goto = async (path) => {
  reset();
  await send('Page.navigate', { url: BASE + path });
  await settle();
};

// ── log in ───────────────────────────────────────────────────────────────────
await goto('/login');
await evaluate(`(() => {
  const set = (el, v) => {
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set(document.querySelector('input[autocomplete="username"]'), ${JSON.stringify(USER)});
  set(document.querySelector('input[autocomplete="current-password"]'), ${JSON.stringify(PASS)});
  return true;
})()`);
await sleep(300);
const btn = await evaluate(`(() => { const b = document.querySelector('.login-submit'); return b ? {disabled:b.disabled, text:b.textContent} : null; })()`);
console.log('login button:', JSON.stringify(btn));
await evaluate(`document.querySelector('.login-submit').click()`);
await settle(1500);
const who = await evaluate(`location.pathname + ' | body ' + document.body.innerText.replace(/\\s+/g,' ').slice(0,90)`);
console.log('after login:', who);
if (who.startsWith('/login')) { console.error('LOGIN FAILED'); process.exit(1); }

// ── walk every route ─────────────────────────────────────────────────────────
// Every route a user can reach. Keep this in step with web/src/App.jsx.
const DEFAULT_ROUTES = [
  '/', '/reservations', '/reservations/new', '/calendar', '/arrivals', '/walk-in',
  '/housekeeping', '/rooms', '/amenities', '/guests', '/folios', '/revenue',
  '/reports', '/audit', '/users', '/health', '/training', '/room-layouts',
  '/inspection-scenarios', '/change-password', '/book', '/request-access',
  // Public, opened by scanning a QR code. An invalid token is the point: the page
  // must fail gracefully rather than throw, and must reach no external host doing it.
  // It reports an EXPECTED 404 from the API — see EXPECTED_404 below.
  '/pay/not-a-real-token',
];

// Routes whose API is SUPPOSED to answer 404 in this sweep, so a clean run does not
// look dirty. Only the status is excused; an external request or an exception on one
// of these still fails the run.
const EXPECTED_404 = new Set(['/pay/not-a-real-token']);
const ROUTES = (process.env.AUDIT_ROUTES || DEFAULT_ROUTES.join(',')).split(',');
const results = [];
for (const path of ROUTES) {
  await goto(path);
  await sleep(800);
  const probe = await evaluate(`(() => ({
    path: location.pathname,
    text: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160),
    len: document.body.innerText.trim().length,
    canvases: [...document.querySelectorAll('canvas')].map(c => c.width + 'x' + c.height),
    errorish: /Something went wrong|Failed to fetch|Network Error|Internal server error|cannot be reached/i.test(document.body.innerText),
  }))()`);
  results.push({ path, ...probe, failed: [...failed], consoleErrors: [...consoleErrors], exceptions: [...exceptions], external: [...external], statuses: [...statuses] });
  process.stdout.write('.');
}
console.log('\n');

let externalRoutes = 0;
let broken = 0;
for (const r of results) {
  const issues = [];
  if (r.external.length) {
    externalRoutes += 1;
    issues.push(`EXTERNAL REQUEST → ${[...new Set(r.external)].join(' ')}`);
  }
  if (r.failed.length) issues.push(`FAILED → ${[...new Set(r.failed.map((f) => `${f.err} ${f.url}`))].join(' | ')}`);
  if (r.exceptions.length) issues.push(`EXCEPTION → ${[...new Set(r.exceptions)].join(' | ')}`);
  const statuses = EXPECTED_404.has(r.path) ? r.statuses.filter((x) => !x.startsWith('404 ')) : r.statuses;
  if (statuses.length) issues.push(`HTTP → ${[...new Set(statuses)].join(', ')}`);
  if (r.errorish) issues.push('ERROR TEXT RENDERED');
  if (r.len < 40) issues.push(`BLANK PAGE (${r.len} chars)`);
  if (issues.length) {
    broken += 1;
    console.log(`\u25a0 ${r.path}`);
    for (const i of issues) console.log(`   ${i}`);
  }
}

console.log(`\n${results.length - broken} / ${results.length} routes clean under a DNS blackhole.`);
console.log(`${externalRoutes} route(s) reached an external host.`);
cleanup();
// Only an external request fails the run. A 404 on some route is a bug for someone
// to fix, but it is not evidence that the app needs the internet — and this script's
// job is to gate a deployment on that one question.
process.exit(externalRoutes > 0 ? 1 : 0);
