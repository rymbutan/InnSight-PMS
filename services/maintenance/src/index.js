const express = require('express');
const maintenanceRoutes = require('./routes/maintenance.routes');
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
const logger = makeLogger('maintenance');
const { startSubscriber } = require('./subscribers/redis.subscriber');

const { activityLog } = require('./lib/activityLog');
const app = express();
const PORT = process.env.PORT || 3009;

// cors handled by gateway
app.use(express.json());
app.use(requestContext(logger));
app.use(metricsMiddleware);
app.get('/metrics', metricsHandler);
mountDocs(app, buildSpec({ serviceName: 'maintenance', description: 'InnSight maintenance service' }));

BigInt.prototype.toJSON = function () {
  return this.toString();
};

app.get('/health', (req, res) => {
  res.json({ service: 'maintenance', status: 'healthy', timestamp: new Date().toISOString() });
});

app.use('/api', verifyToken, idempotency, activityLog({ service: 'maintenance' }), maintenanceRoutes);

const subscriber = startSubscriber();

app.use(jsonErrorHandler);

const server = app.listen(PORT, () => {
  console.log(`[InnSight] Maintenance Service running on port ${PORT}`);
});

gracefulShutdown(server, [() => subscriber?.disconnect?.()]);
