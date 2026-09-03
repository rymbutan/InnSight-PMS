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

app.use('/api', verifyToken, idempotency, folioRoutes);

const subscriber = startSubscriber();

app.use(jsonErrorHandler);

const server = app.listen(PORT, () => {
  console.log(`[InnSight] Folio Service running on port ${PORT}`);
});

gracefulShutdown(server, [() => subscriber?.disconnect?.()]);
