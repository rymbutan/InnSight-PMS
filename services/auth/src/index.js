const express = require('express');
const authRoutes = require('./routes/auth.routes');
const usersRoutes = require('./routes/users.routes');
const layoutsRoutes = require('./routes/layouts.routes');
const assetsRoutes = require('./routes/assets.routes');
const trainingRoutes = require('./routes/training.routes');
const { verifyToken, requireRole } = require('./middleware/auth');
const { startSubscriber } = require('./subscribers/redis.subscriber');
const {
  makeLogger,
  requestContext,
  metricsMiddleware,
  metricsHandler,
  gracefulShutdown,
  jsonErrorHandler,
} = require('./lib/observability');
const { buildSpec, mountDocs } = require('./lib/openapi');

const logger = makeLogger('auth');
const app = express();
const PORT = process.env.PORT || 3010;

// cors handled by gateway
app.use(express.json());
app.use(requestContext(logger));
app.use(metricsMiddleware);

app.get('/health', (req, res) => {
  res.json({ service: 'auth', status: 'healthy', timestamp: new Date().toISOString() });
});

// Prometheus scrape endpoint.
app.get('/metrics', metricsHandler);

// OpenAPI docs at /docs and /openapi.json
mountDocs(
  app,
  buildSpec({
    serviceName: 'Auth',
    description: 'User authentication, JWT issuance, role/permission management.',
    paths: {
      '/api/auth/login': {
        post: {
          summary: 'Sign in with username + password',
          tags: ['Auth'],
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { username: { type: 'string' }, password: { type: 'string' } },
                  required: ['username', 'password'],
                },
              },
            },
          },
          responses: {
            200: {
              description: 'JWT + user',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { token: { type: 'string' }, user: { type: 'object' } },
                  },
                },
              },
            },
            401: {
              description: 'Invalid credentials',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
      },
      '/api/auth/change-password': {
        post: {
          summary: 'Change current user password',
          tags: ['Auth'],
          responses: { 204: { description: 'Updated' }, 401: { description: 'Bad current password' } },
        },
      },
      '/api/users': {
        get: {
          summary: 'List users (ADMIN/MANAGER)',
          tags: ['Users'],
          responses: { 200: { description: 'OK' } },
        },
        post: {
          summary: 'Create user (ADMIN/MANAGER)',
          tags: ['Users'],
          responses: { 201: { description: 'Created' } },
        },
      },
      '/api/health/services': {
        get: {
          summary: 'System-wide health roll-up',
          tags: ['Ops'],
          responses: { 200: { description: 'OK' } },
        },
      },
    },
  })
);

// System-wide health roll-up — pings every sibling service's /health.
const SERVICES = [
  { name: 'auth', url: 'http://localhost:' + PORT + '/health' },
  { name: 'inventory', url: process.env.INVENTORY_URL || 'http://inventory-service:3005' },
  { name: 'stay', url: process.env.STAY_URL || 'http://stay-service:3006' },
  { name: 'folio', url: process.env.FOLIO_URL || 'http://folio-service:3007' },
  { name: 'guest', url: process.env.GUEST_URL || 'http://guest-service:3008' },
  { name: 'maintenance', url: process.env.MAINTENANCE_URL || 'http://maintenance-service:3009' },
  { name: 'reservation', url: process.env.RESERVATION_URL || 'http://reservation-service:3011' },
  { name: 'audit', url: process.env.AUDIT_URL || 'http://audit-service:3012' },
  { name: 'reports', url: process.env.REPORTS_URL || 'http://reports-service:3013' },
];

app.get('/api/health/services', verifyToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const checks = await Promise.all(
    SERVICES.map(async (s) => {
      const url = s.url.endsWith('/health') ? s.url : `${s.url}/health`;
      const start = Date.now();
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 2000);
        const r = await fetch(url, { signal: ctl.signal });
        clearTimeout(t);
        return {
          service: s.name,
          status: r.ok ? 'up' : 'degraded',
          httpCode: r.status,
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        return {
          service: s.name,
          status: 'down',
          error: err.name === 'AbortError' ? 'timeout' : err.message,
          latencyMs: Date.now() - start,
        };
      }
    })
  );
  const allUp = checks.every((c) => c.status === 'up');
  res.json({ overall: allUp ? 'up' : 'degraded', services: checks, checkedAt: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api', trainingRoutes);
app.use('/api', usersRoutes);
app.use('/api', layoutsRoutes);
app.use('/api', assetsRoutes);

const subscriber = startSubscriber();

app.use(jsonErrorHandler);

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, '[InnSight] Auth Service running');
});

gracefulShutdown(server, [() => subscriber?.disconnect?.()]);
