const express = require('express');
const folioRoutes = require('./routes/folio.routes');
const { verifyToken } = require('./middleware/auth');
const { idempotency } = require('./middleware/idempotency');
const {
  makeLogger,
  requestContext,
  metricsMiddleware,
  metricsHandler,
  gracefulShutdown,
  jsonErrorHandler,
} = require('./lib/observability');
const { buildSpec, mountDocs } = require('./lib/openapi');
const logger = makeLogger('folio');
const { startSubscriber } = require('./subscribers/redis.subscriber');

const { activityLog } = require('./lib/activityLog');
const app = express();
const PORT = process.env.PORT || 3007;

// cors handled by gateway
app.use(express.json());
app.use(requestContext(logger));
app.use(metricsMiddleware);
app.get('/metrics', metricsHandler);
mountDocs(app, buildSpec({ serviceName: 'folio', description: 'InnSight folio service' }));

app.get('/health', (req, res) => {
  res.json({ service: 'folio', status: 'healthy', timestamp: new Date().toISOString() });
});

// BigInt JSON support
BigInt.prototype.toJSON = function () {
  return this.toString();
};

// ── PUBLIC routes — mounted BEFORE verifyToken, so no session is required ─────
//
// Opened by whatever scanned a QR code: a phone with no login, or a second
// browser window in a classroom demo. The payment-intent confirm/read routes
// and the folio-PDF route all live in folio.routes.js's `publicRouter` — one
// place for every unauthenticated, token-is-the-credential route this service
// exposes, rather than splitting some of them out here.
app.use('/api/public', folioRoutes.publicRouter);

app.use('/api', verifyToken, idempotency, activityLog({ service: 'folio' }), folioRoutes);

const subscriber = startSubscriber();

app.use(jsonErrorHandler);

const server = app.listen(PORT, () => {
  console.log(`[InnSight] Folio Service running on port ${PORT}`);
});

// Best-effort: a bucket that doesn't exist yet is created lazily on the first
// upload attempt too (see routes), so a MinIO hiccup at boot doesn't crash a
// service that has nothing to do with proof-of-transfer uploads on its
// critical path.
require('./lib/storage')
  .ensureBucket()
  .catch((e) => console.warn('[Folio] Could not ensure MinIO bucket at startup:', e.message));

gracefulShutdown(server, [() => subscriber?.disconnect?.()]);
