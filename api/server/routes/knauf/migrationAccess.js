// [knauf] GET /api/knauf/migration/access
//
// Returns whether the currently authenticated user is on the migration
// allowlist. The frontend calls this once after Okta login to decide
// whether to show the app or the "not yet enabled" screen.
//
// Response: { allowed: boolean }
'use strict';

const express = require('express');
const { requireJwtAuth } = require('~/server/middleware');
const { isEmailAllowed } = require('~/server/knauf/migrationAllowlist');

const router = express.Router();

router.get('/', requireJwtAuth, async (req, res) => {
  try {
    const email = req.user?.email;
    if (!email) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const allowed = await isEmailAllowed(email);
    return res.json({ allowed });
  } catch (err) {
    return res.status(503).json({ message: 'Access check temporarily unavailable. Please try again shortly.' });
  }
});

module.exports = router;
// End [knauf]
