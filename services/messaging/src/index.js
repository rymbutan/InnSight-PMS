const express = require('express');
const messagesRoutes = require('./routes/messages.routes');
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
const logger = makeLogger('messaging');
const { startSubscriber } = require('./subscribers/redis.subscriber');

const app = express();
const PORT = process.env.PORT || 3014;

// cors handled by gateway
app.use(express.json());
app.use(requestContext(logger));
app.use(metricsMiddleware);
app.get('/metrics', metricsHandler);
mountDocs(app, buildSpec({ serviceName: 'messaging', description: 'InnSight messaging service' }));

BigInt.prototype.toJSON = function () {
  return this.toString();
};

app.get('/health', (req, res) => {
  res.json({ service: 'messaging', status: 'healthy', timestamp: new Date().toISOString() });
});

app.use('/api', verifyToken, idempotency, messagesRoutes);

const subscriber = startSubscriber();

app.use(jsonErrorHandler);

const server = app.listen(PORT, () => {
  console.log(`[InnSight] Messaging Service running on port ${PORT}`);
});

gracefulShutdown(server, [() => subscriber?.disconnect?.()]);
