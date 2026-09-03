// Shared observability primitives — used by every service for consistent
// logging, request tracing, and Prometheus metrics.
//
// Why a single file rather than an npm package?
// Each service has its own package.json + Dockerfile, so symlinking or
// publishing a private package would complicate the docker build. We instead
// `require()` this file via a relative path. To use:
//
//   const { logger, requestContext, metricsMiddleware, metricsHandler,
//           gracefulShutdown } = require('../_shared/observability');
//
// Falls back gracefully if optional deps (pino, prom-client) aren't installed.

const crypto = require('crypto');

// ── Logger ──────────────────────────────────────────────────────────
let pino;
try {
  pino = require('pino');
} catch {
  pino = null;
}

function makeLogger(service) {
  if (!pino) {
    // Fallback: console with a service prefix.
    const log =
      (level) =>
      (...args) =>
        console.log(`[${service}] [${level}]`, ...args);
    return {
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      debug: log('debug'),
      child: () => makeLogger(service),
    };
  }
  return pino({
    name: service,
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: ['req.headers.authorization', '*.password', '*.token', '*.cardNumber', '*.cvv'],
  });
}

// ── Request-id middleware ──────────────────────────────────────────
// Reads `X-Request-Id` from the gateway, or generates a fresh one. Attaches
// `req.id` and `req.log` (a child logger bound to that id), and echoes the
// id back as a response header so clients can correlate.
function requestContext(logger) {
  return function (req, res, next) {
    const id = req.get('X-Request-Id') || crypto.randomUUID();
    req.id = id;
    req.log = logger.child ? logger.child({ reqId: id }) : logger;
    res.set('X-Request-Id', id);
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      req.log.info(
        {
          method: req.method,
          url: req.originalUrl,
          status: res.statusCode,
          ms,
          userId: req.user?.sub,
        },
        'http_request'
      );
    });
    next();
  };
}

// ── Prometheus metrics ──────────────────────────────────────────────
let promClient;
try {
  promClient = require('prom-client');
} catch {
  promClient = null;
}

let registry, httpDuration, httpTotal;
if (promClient) {
  registry = new promClient.Registry();
  promClient.collectDefaultMetrics({ register: registry });
  httpDuration = new promClient.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  httpTotal = new promClient.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });
}

function metricsMiddleware(req, res, next) {
  if (!promClient) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    // Use the matched route pattern (bounded set of label values). Unmatched
    // paths (404s, scanners) collapse to a single 'unmatched' label so a flood
    // of distinct URLs can't blow up Prometheus label cardinality.
    const route = req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : 'unmatched';
    const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = { method: req.method, route, status: String(res.statusCode) };
    httpDuration.observe(labels, elapsed);
    httpTotal.inc(labels);
  });
  next();
}

async function metricsHandler(req, res) {
  if (!promClient) return res.status(503).json({ error: 'metrics not available' });
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
}

// ── Graceful shutdown ───────────────────────────────────────────────
// Pass any number of cleanup functions; they all run on SIGTERM/SIGINT before exit.
function gracefulShutdown(server, cleanups = []) {
  let shuttingDown = false;
  // exitCode lets a CRASH drain like a signal but still exit non-zero, so Docker /
  // an orchestrator can tell a fault from an intentional stop.
  const handler = async (signal, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, draining…`);
    const hardExit = setTimeout(() => {
      console.error('[shutdown] drain timed out — forcing exit');
      process.exit(1);
    }, 10_000);
    hardExit.unref();
    try {
      // Stop accepting new connections and WAIT for in-flight requests to
      // finish before running cleanups and exiting.
      await new Promise((resolve) =>
        server.close(() => {
          console.log('[shutdown] http server closed');
          resolve();
        })
      );
      await Promise.all(
        cleanups.map((fn) =>
          Promise.resolve()
            .then(fn)
            .catch((e) => console.error('[shutdown] cleanup failed:', e.message))
        )
      );
      clearTimeout(hardExit);
      process.exit(exitCode);
    } catch (e) {
      console.error('[shutdown] error:', e.message);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));

  // ── Crash safety ──────────────────────────────────────────────────
  // There were ZERO unhandledRejection / uncaughtException handlers anywhere in
  // this codebase. Under Node 20 an unhandled rejection TERMINATES the process,
  // and with `restart: unless-stopped` in compose that is a silent crash-loop: the
  // container flaps, the gateway 502s intermittently, and nothing in the logs says
  // why because the default handler prints to stderr and dies.
  //
  // There is a real example of this shape in the tree: an uncaught
  // `redis.publish(...)` in auth.routes.js, in a service that registers no
  // `redis.on('error')` handler at all.
  //
  // Policy: LOG LOUDLY, then drain and exit non-zero. Deliberately not
  // swallow-and-continue — after an unhandled rejection the process is in an
  // unknown state, and a restart is safer than serving from it. The difference from
  // today is that the reason is recorded and in-flight requests get to finish.
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error('[fatal] unhandled promise rejection:', detail);
    handler('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaught exception:', err?.stack || err?.message || String(err));
    handler('uncaughtException', 1);
  });
}

// ── Global JSON error handler ───────────────────────────────────────
// Mount LAST (after routes). Anything that reaches Express's error path —
// e.g. a malformed JSON request body (express.json throws a SyntaxError) —
// returns a consistent JSON shape instead of nginx/Express HTML. Real error
// detail is logged, never sent to the client.
function jsonErrorHandler(err, req, res, next) {
  // eslint-disable-line no-unused-vars
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (req.log?.error) req.log.error({ err }, 'unhandled error');
  else console.error('[error]', err.message);
  res.status(status).json({ error: status === 400 ? 'Malformed request.' : 'Internal server error.' });
}

module.exports = {
  makeLogger,
  requestContext,
  metricsMiddleware,
  metricsHandler,
  gracefulShutdown,
  jsonErrorHandler,
};
