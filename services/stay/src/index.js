const express = require('express');
const stayRoutes = require('./routes/stay.routes');
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
const logger = makeLogger('stay');
const { startSubscriber } = require('./subscribers/redis.subscriber');

const app = express();
const PORT = process.env.PORT || 3006;

// cors handled by gateway
app.use(express.json());
app.use(requestContext(logger));
app.use(metricsMiddleware);
app.get('/metrics', metricsHandler);
mountDocs(app, buildSpec({ serviceName: 'stay', description: 'InnSight stay service' }));

app.get('/health', (req, res) => {
  res.json({ service: 'stay', status: 'healthy', timestamp: new Date().toISOString() });
});

app.use('/api', verifyToken, idempotency, stayRoutes);

const subscriber = startSubscriber();

app.use(jsonErrorHandler);

const server = app.listen(PORT, () => {
  console.log(`[InnSight] Stay Service running on port ${PORT}`);
});

gracefulShutdown(server, [() => subscriber?.disconnect?.()]);
