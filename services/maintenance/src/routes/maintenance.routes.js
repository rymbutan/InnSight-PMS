const express = require('express');
const Redis = require('ioredis');
const { requireRole, ROLE_GROUPS } = require('../middleware/auth');

// Anyone can report an issue (create), but triage/assign/start/complete/verify
// and asset management are restricted to maintenance staff and managers.
// HOUSEKEEPING and MAINTENANCE were merged into one role (Unified Staff Role) —
// see ROLE_GROUPS.MAINT in middleware/auth.js.
const MAINT = ['ADMIN', 'MANAGER', 'HOUSEKEEPING_MAINTENANCE'];
// Any operational role can REPORT an issue; only MAINT progresses the work order.
const REPORTER = ['ADMIN', 'MANAGER', 'HOUSEKEEPING_MAINTENANCE', 'FRONT_DESK'];

const router = express.Router();
const prisma = require('../lib/prisma');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
redis.on('error', (e) => console.error('[Maintenance] redis error:', e.message));

function nextWoNumber() {
  return `WO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

// Ensures a work order exists and is in one of the allowed prior states before
// a lifecycle transition. Returns the order, or sends 404/409 and returns null.
async function requireWorkOrderState(id, allowedFrom, res) {
  const wo = await prisma.workOrder.findUnique({ where: { id } });
  if (!wo) {
    res.status(404).json({ error: 'Work order not found.' });
    return null;
  }
  if (!allowedFrom.includes(wo.status)) {
    res.status(409).json({ error: `Cannot perform this action on a ${wo.status} work order.` });
    return null;
  }
  return wo;
}

// POST /api/work-orders
router.post('/work-orders', requireRole(...REPORTER), async (req, res) => {
  try {
    const { type, priority, category, roomId, assetId, reportedBy, description, estimatedMinutes } = req.body;
    const wo = await prisma.workOrder.create({
      data: {
        workOrderNumber: nextWoNumber(),
        type: type || 'REACTIVE',
        priority: priority || 'NORMAL',
        category,
        roomId,
        assetId,
        reportedBy,
        description,
        estimatedMinutes,
      },
    });
    redis.publish(
      'maintenance:work_order_created',
      JSON.stringify({ workOrderId: wo.id, roomId, priority: wo.priority })
    );
    if (roomId && (wo.priority === 'EMERGENCY' || wo.priority === 'URGENT')) {
      redis.publish(
        'room:maintenance',
        JSON.stringify({
          type: 'MAINTENANCE_ISSUE',
          roomId,
          workOrderId: wo.id,
          description,
        })
      );
    }
    res.status(201).json(wo);
  } catch (err) {
    console.error('[Maintenance] Create WO error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/work-orders
router.get('/work-orders', requireRole(...ROLE_GROUPS.ALL_STAFF), async (req, res) => {
  try {
    const { status, priority, roomId } = req.query;
    const where = {};
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (roomId) where.roomId = roomId;
    const list = await prisma.workOrder.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json(list);
  } catch (err) {
    console.error('[Maintenance] List WO error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/work-orders/:id
router.get('/work-orders/:id', requireRole(...ROLE_GROUPS.ALL_STAFF), async (req, res) => {
  try {
    const wo = await prisma.workOrder.findUnique({ where: { id: req.params.id } });
    if (!wo) return res.status(404).json({ error: 'Not found.' });
    res.json(wo);
  } catch (err) {
    console.error('[Maintenance] Get WO error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/work-orders/:id/triage
router.post('/work-orders/:id/triage', requireRole(...MAINT), async (req, res) => {
  try {
    const { priority, category } = req.body;
    if ((await requireWorkOrderState(req.params.id, ['REPORTED'], res)) === null) return;
    const wo = await prisma.workOrder.update({
      where: { id: req.params.id },
      data: { status: 'TRIAGED', priority, category },
    });
    res.json(wo);
  } catch (err) {
    console.error('[Maintenance] Triage error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/work-orders/:id/assign
router.post('/work-orders/:id/assign', requireRole(...MAINT), async (req, res) => {
  try {
    const { assignedTo, scheduledFor } = req.body;
    if ((await requireWorkOrderState(req.params.id, ['REPORTED', 'TRIAGED'], res)) === null) return;
    const wo = await prisma.workOrder.update({
      where: { id: req.params.id },
      data: {
        status: 'ASSIGNED',
        assignedTo,
        scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
      },
    });
    res.json(wo);
  } catch (err) {
    console.error('[Maintenance] Assign error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/work-orders/:id/start
router.post('/work-orders/:id/start', requireRole(...MAINT), async (req, res) => {
  try {
    const { roomOutOfService } = req.body;
    if ((await requireWorkOrderState(req.params.id, ['ASSIGNED', 'TRIAGED'], res)) === null) return;
    const wo = await prisma.workOrder.update({
      where: { id: req.params.id },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date(),
        roomOutOfService: !!roomOutOfService,
      },
    });
    if (roomOutOfService && wo.roomId) {
      redis.publish(
        'maintenance:room_out_of_service',
        JSON.stringify({ roomId: wo.roomId, workOrderId: wo.id })
      );
    }
    res.json(wo);
  } catch (err) {
    console.error('[Maintenance] Start error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/work-orders/:id/complete
router.post('/work-orders/:id/complete', requireRole(...MAINT), async (req, res) => {
  try {
    const { actualMinutes, totalCostCents } = req.body;
    if ((await requireWorkOrderState(req.params.id, ['IN_PROGRESS'], res)) === null) return;
    const wo = await prisma.workOrder.update({
      where: { id: req.params.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        actualMinutes,
        totalCostCents: BigInt(totalCostCents || 0),
      },
    });
    res.json(wo);
  } catch (err) {
    console.error('[Maintenance] Complete error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/work-orders/:id/verify
router.post('/work-orders/:id/verify', requireRole(...MAINT), async (req, res) => {
  try {
    if ((await requireWorkOrderState(req.params.id, ['COMPLETED'], res)) === null) return;
    const wo = await prisma.workOrder.update({
      where: { id: req.params.id },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    });
    if (wo.roomOutOfService && wo.roomId) {
      redis.publish('maintenance:room_restored', JSON.stringify({ roomId: wo.roomId, workOrderId: wo.id }));
    }
    res.json(wo);
  } catch (err) {
    console.error('[Maintenance] Verify error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/assets
router.get('/assets', requireRole(...ROLE_GROUPS.MAINT), async (req, res) => {
  try {
    const assets = await prisma.asset.findMany({ orderBy: { name: 'asc' } });
    res.json(assets);
  } catch (err) {
    console.error('[Maintenance] List assets error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/assets
const ASSET_FIELDS = [
  'tag',
  'name',
  'category',
  'location',
  'manufacturer',
  'model',
  'serialNumber',
  'purchaseDate',
  'warrantyExpiresAt',
  'status',
];
router.post('/assets', requireRole(...MAINT), async (req, res) => {
  try {
    if (!req.body.tag || !req.body.name || !req.body.category) {
      return res.status(400).json({ error: 'tag, name and category are required.' });
    }
    // Whitelist columns — the client must not set id/service dates/unknown keys.
    const data = {};
    for (const k of ASSET_FIELDS) {
      if (req.body[k] !== undefined) {
        data[k] =
          (k === 'purchaseDate' || k === 'warrantyExpiresAt') && req.body[k]
            ? new Date(req.body[k])
            : req.body[k];
      }
    }
    const asset = await prisma.asset.create({ data });
    res.status(201).json(asset);
  } catch (err) {
    if (err.code === 'P2002')
      return res.status(409).json({ error: 'An asset with that tag already exists.' });
    console.error('[Maintenance] Create asset error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/parts?lowStock=true
router.get('/parts', requireRole(...ROLE_GROUPS.MAINT), async (req, res) => {
  try {
    const { lowStock } = req.query;
    let parts = await prisma.part.findMany({ orderBy: { name: 'asc' } });
    if (lowStock === 'true') {
      parts = parts.filter((p) => p.onHand <= p.minStock);
    }
    res.json(parts);
  } catch (err) {
    console.error('[Maintenance] List parts error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
