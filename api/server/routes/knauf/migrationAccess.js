// [knauf] Migration access routes
//
// Two endpoints:
//
// 1. GET /api/knauf/migration/access
//    For the AGK frontend — requires Okta JWT, returns allowed status for the logged-in user.
//    Returns { allowed: true } immediately when MIGRATION_ALLOWLIST_ENABLED !== 'true'.
//
// 2. GET /api/knauf/migration/access/check
//    For third-party apps — requires X-Knauf-Api-Key header + ?email= query param.
//    Always performs a real allowlist lookup regardless of MIGRATION_ALLOWLIST_ENABLED,
//    because external callers rely on this endpoint as a trusted contract.
//
// Response: { allowed: boolean }
'use strict';

const express = require('express');
const { requireJwtAuth } = require('~/server/middleware');
const requireKnaufApiKey = require('~/server/middleware/requireKnaufApiKey');
const { isEmailAllowed } = require('~/server/knauf/migrationAllowlist');

const router = express.Router();

const isGateEnabled = () => process.env.MIGRATION_ALLOWLIST_ENABLED === 'true';

// --- Frontend endpoint (JWT) ---
router.get('/', requireJwtAuth, async (req, res) => {
  if (!isGateEnabled()) {
    return res.json({ allowed: true });
  }
  const email = req.user?.email;
  if (!email) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  try {
    const allowed = await isEmailAllowed(email);
    return res.json({ allowed });
  } catch (err) {
    return res.status(503).json({
      message: 'Access check temporarily unavailable. Please try again shortly.',
    });
  }
});

// --- Third-party endpoint (API key) ---
// Always performs a real allowlist lookup — MIGRATION_ALLOWLIST_ENABLED does not bypass this
// endpoint because external callers rely on it as a trusted contract.
router.get('/check', requireKnaufApiKey, async (req, res) => {
  const email = req.query.email;
  if (!email || typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ message: 'Bad Request: email query parameter is required' });
  }
  try {
    const allowed = await isEmailAllowed(email.trim());
    return res.json({ allowed });
  } catch (err) {
    return res.status(503).json({
      message: 'Access check temporarily unavailable. Please try again shortly.',
    });
  }
});

module.exports = router;
// End [knauf]
