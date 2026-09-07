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

// ── PUBLIC routes — mounted BEFORE verifyToken, so no session is required ─────
//
// These are opened by whatever scanned a QR code: a phone with no login, or a
// second browser window in a classroom demo. The intent token IS the credential —
// 32 random bytes, single use, short-lived (see lib/paymentIntent.js).
//
// Deliberately minimal in what they return. A stranger who guesses a token learns
// the amount and the hotel name, never the guest, the room or the folio contents.
const publicPrisma = require('./lib/prisma');
const { intentState } = require('./lib/paymentIntent');
const publicRedis = new (require('ioredis'))(process.env.REDIS_URL || 'redis://localhost:6379');

app.get('/api/public/payment-intents/:token', async (req, res) => {
  try {
    const intent = await publicPrisma.paymentIntent.findUnique({ where: { token: req.params.token } });
    if (!intent) return res.status(404).json({ error: 'This payment link is not valid.' });
    res.json({
      state: intentState(intent),
      amountCents: intent.amountCents.toString(),
      currency: 'PHP',
      method: intent.method,
      expiresAt: intent.expiresAt,
    });
  } catch (err) {
    console.error('[Folio] Public intent read error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.post('/api/public/payment-intents/:token/confirm', async (req, res) => {
  try {
    const intent = await publicPrisma.paymentIntent.findUnique({ where: { token: req.params.token } });
    if (!intent) return res.status(404).json({ error: 'This payment link is not valid.' });

    const state = intentState(intent);
    if (state !== 'PENDING') {
      // 409 with the actual state, so the page can say "already paid" or "expired"
      // rather than a generic failure the student cannot act on.
      return res.status(409).json({ error: `This payment link is ${state.toLowerCase()}.`, state });
    }

    // One transaction for all three writes. Flipping the intent to CONFIRMED in the
    // SAME transaction as the payment is what makes a double scan safe: the second
    // one finds it already confirmed and stops, instead of posting twice.
    const [, payment] = await publicPrisma.$transaction([
      publicPrisma.paymentIntent.update({
        where: { id: intent.id, status: 'PENDING' },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      }),
      publicPrisma.payment.create({
        data: {
          folioId: intent.folioId,
          method: intent.method,
          amountCents: intent.amountCents,
          status: 'CAPTURED',
          gatewayRef: `SIM-${intent.id.slice(-12)}`,
        },
      }),
      publicPrisma.folioTransaction.create({
        data: {
          folioId: intent.folioId,
          type: 'PAYMENT',
          description: `Payment via ${intent.method} (simulated)`,
          amountCents: intent.amountCents,
          paymentMethod: intent.method,
          sourceSystem: 'qr-simulation',
        },
      }),
    ]);

    // What makes this worth demonstrating: the front-desk screen updates itself.
    publicRedis.publish(
      // The established folio channel, not a new 'payment:received': every page
      // that declares the folio domain is already subscribed to this one, and the
      // SSE gateway only forwards whitelisted channels.
      'folio:payment_received',
      JSON.stringify({
        folioId: intent.folioId,
        paymentId: payment.id,
        amountCents: intent.amountCents.toString(),
      })
    );

    res.json({ state: 'CONFIRMED', amountCents: intent.amountCents.toString() });
  } catch (err) {
    // A lost race on the status guard lands here: the row was PENDING when read and
    // CONFIRMED by the time it was updated. That is a double scan, not an outage.
    if (err.code === 'P2025') return res.status(409).json({ error: 'This payment has already been made.', state: 'CONFIRMED' });
    console.error('[Folio] Public confirm error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// The folio's QR code, scanned unauthenticated — same routing precedent as the
// payment-intent routes above. Lives in folio.routes.js since serving it means
// rebuilding the exact print model that route file already knows how to build.
app.use('/api/public', folioRoutes.publicRouter);

app.use('/api', verifyToken, idempotency, folioRoutes);

const subscriber = startSubscriber();

app.use(jsonErrorHandler);

const server = app.listen(PORT, () => {
  console.log(`[InnSight] Folio Service running on port ${PORT}`);
});

gracefulShutdown(server, [() => subscriber?.disconnect?.()]);
