const express = require('express');
const guestRoutes = require('./routes/guest.routes');
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
const logger = makeLogger('guest');
const { startSubscriber } = require('./subscribers/redis.subscriber');

const { activityLog } = require('./lib/activityLog');
const app = express();
const PORT = process.env.PORT || 3008;

// cors handled by gateway
app.use(express.json());
app.use(requestContext(logger));
app.use(metricsMiddleware);
app.get('/metrics', metricsHandler);
mountDocs(app, buildSpec({ serviceName: 'guest', description: 'InnSight guest service' }));

app.get('/health', (req, res) => {
  res.json({ service: 'guest', status: 'healthy', timestamp: new Date().toISOString() });
});

app.use('/api', verifyToken, idempotency, activityLog({ service: 'guest' }), guestRoutes);

const subscriber = startSubscriber();

app.use(jsonErrorHandler);

const server = app.listen(PORT, () => {
  console.log(`[InnSight] Guest Service running on port ${PORT}`);
});

gracefulShutdown(server, [() => subscriber?.disconnect?.()]);
