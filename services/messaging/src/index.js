const express = require('express');
const messagesRoutes = require('./routes/messages.routes');
const settingsRoutes = require('./routes/settings.routes');
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
const { startSweeper } = require('./retention/policy');

const { activityLog } = require('./lib/activityLog');
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

// BOTH routers on ONE mount, and that is not a tidiness preference.
//
// Two separate `app.use('/api', verifyToken, idempotency, …)` lines look
// equivalent and are not: the middleware chain of a mount runs on every request
// whose path starts with '/api', BEFORE the router gets to decide it has no
// matching route. So a POST /api/messages would run `idempotency` once for the
// settings mount — taking the in-flight lock for its Idempotency-Key — fall
// through unmatched, and then run `idempotency` a second time for the messages
// mount, where it would find the lock already held by itself and answer 409
// "Idempotent request already in progress." Every send and every presence
// heartbeat failed that way. Listing the routers as two handlers of one mount
// runs the guards once, in order, which is what was meant.
//
// Settings is first so the fixed path /messages/settings/retention is matched
// before anything with a wildcard segment could grow to cover it.
app.use(
  '/api',
  verifyToken,
  idempotency,
  activityLog({ service: 'messaging' }),
  settingsRoutes,
  messagesRoutes
);

const subscriber = startSubscriber();

// Retention. Deletes messages past the configured lifetime; a no-op under the
// shipped "keep messages" default, so this is inert until an admin turns it on.
const sweeper = startSweeper();

app.use(jsonErrorHandler);

const server = app.listen(PORT, () => {
  console.log(`[InnSight] Messaging Service running on port ${PORT}`);
});

gracefulShutdown(server, [() => clearInterval(sweeper), () => subscriber?.disconnect?.()]);
