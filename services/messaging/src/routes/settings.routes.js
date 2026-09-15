const express = require('express');

const router = express.Router();
const { requireRole } = require('../middleware/auth');
const retention = require('../retention/policy');

// ─────────────────────────────────────────────────────────────────────────────
// Messaging settings. A SEPARATE ROUTER from messages.routes.js on purpose.
//
// That file's defining property is that not one of its routes carries a role
// guard, because a message belongs to the two people in the conversation rather
// than to a department (its header, and routes/authz.test.js, both say so at
// length). Retention is the opposite kind of thing: it is hotel configuration,
// it changes what every user sees, and it deletes data. Putting an ADMIN guard
// inside that file would have made its "no role guards here, and that is the
// feature" header quietly untrue for the next reader.
//
// Split read from write, the same way the theme setting in the reservation
// service does: anyone signed in may READ the policy, because the Messages page
// tells staff how long what they type will survive, and a rule people cannot see
// is one they will be surprised by. Only an ADMIN may change it.
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/messages/settings/retention
router.get('/messages/settings/retention', async (_req, res) => {
  try {
    const policy = await retention.getPolicy();
    res.json({
      mode: policy.mode,
      label: policy.label,
      detail: policy.detail,
      // Sent so the client renders the same wording the server enforces rather
      // than keeping its own copy of the catalogue, which would drift.
      options: retention.MODES.map((m) => ({ mode: m.mode, label: m.label, detail: m.detail })),
    });
  } catch (err) {
    console.error('[Messaging] Get retention error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PUT /api/messages/settings/retention — ADMIN only; this deletes other
// people's messages.
router.put('/messages/settings/retention', requireRole('ADMIN'), async (req, res) => {
  try {
    const { mode } = req.body || {};
    if (!retention.isMode(mode)) {
      return res.status(400).json({
        error: `Unknown retention setting. Choose one of: ${retention.MODES.map((m) => m.mode).join(', ')}.`,
      });
    }
    const policy = await retention.setPolicy(mode);

    // Apply it immediately rather than waiting up to a minute for the sweep.
    // An admin who shortens the window expects the backlog to go now — and the
    // count is worth returning, because "cleared 1,284 messages" is the moment
    // to find out this was not what they meant.
    let purged = 0;
    try {
      purged = await retention.purgeExpired();
    } catch (err) {
      // The setting is saved either way; the sweep will catch up on its own.
      console.error('[Messaging] Immediate purge after retention change failed:', err.message);
    }

    console.log(`[Messaging] Retention set to "${policy.mode}" by ${req.user.sub} — purged ${purged}.`);
    res.json({ mode: policy.mode, label: policy.label, detail: policy.detail, purged });
  } catch (err) {
    console.error('[Messaging] Set retention error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
