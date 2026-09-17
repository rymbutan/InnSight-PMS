const express = require('express');
const auditRoutes = require('./routes/audit.routes');
const activityRoutes = require('./routes/activity.routes');
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
const logger = makeLogger('audit');
const { startSubscriber } = require('./subscribers/redis.subscriber');
const { activityLog } = require('./lib/activityLog');

const app = express();
const PORT = process.env.PORT || 3012;

// cors handled by gateway
app.use(express.json());
app.use(requestContext(logger));
app.use(metricsMiddleware);
app.get('/metrics', metricsHandler);
mountDocs(app, buildSpec({ serviceName: 'audit', description: 'InnSight audit service' }));

BigInt.prototype.toJSON = function () {
  return this.toString();
};

app.get('/health', (req, res) => {
  res.json({ service: 'audit', status: 'healthy', timestamp: new Date().toISOString() });
});

// activityLog records this service's OWN writes (opening a business day,
// running the night audit) the same way it records every other service's.
// activityRoutes is read-only and therefore records nothing itself.
app.use('/api', verifyToken, idempotency, activityLog({ service: 'audit' }), auditRoutes, activityRoutes);

const subscriber = startSubscriber();

app.use(jsonErrorHandler);

const server = app.listen(PORT, () => {
  console.log(`[InnSight] Audit Service running on port ${PORT}`);
});

gracefulShutdown(server, [() => subscriber?.disconnect?.()]);
