// Tiny OpenAPI 3.0 spec generator + Swagger UI mounter.
// Each service builds its own spec via tagging route metadata, then mounts
// `/docs` (interactive UI) and `/openapi.json` (raw spec). Falls back gracefully
// if `swagger-ui-express` isn't installed.

let swaggerUi = null;
try {
  swaggerUi = require('swagger-ui-express');
} catch {
  /* optional */
}

function buildSpec({ serviceName, description, version = '1.0.0', paths = {}, components = {} }) {
  return {
    openapi: '3.0.3',
    info: {
      title: `InnSight PMS · ${serviceName}`,
      description,
      version,
      contact: { name: 'InnSight Capstone (SLSU)' },
      license: { name: 'MIT' },
    },
    servers: [{ url: 'http://localhost:8080', description: 'Gateway (dev)' }],
    tags: [{ name: serviceName, description }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'POST /api/auth/login → use the returned token as `Authorization: Bearer <token>`',
        },
        ...(components.securitySchemes || {}),
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string', example: 'Forbidden.' } },
          required: ['error'],
        },
        ...(components.schemas || {}),
      },
    },
    security: [{ bearerAuth: [] }],
  };
}

function mountDocs(app, spec) {
  app.get('/openapi.json', (req, res) => res.json(spec));
  if (swaggerUi) {
    app.use(
      '/docs',
      swaggerUi.serve,
      swaggerUi.setup(spec, {
        customSiteTitle: spec.info.title,
        customCss: '.swagger-ui .topbar { display: none }',
      })
    );
  } else {
    app.get('/docs', (req, res) => res.status(503).json({ error: 'swagger-ui-express not installed' }));
  }
}

module.exports = { buildSpec, mountDocs };
