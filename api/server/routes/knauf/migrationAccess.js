// [knauf] Migration access routes
//
// Two endpoints:
//
// 1. GET /api/knauf/migration/access
//    For the AGK frontend — requires Okta JWT, returns allowed status for the logged-in user.
//
// 2. GET /api/knauf/migration/access/check
//    For third-party apps — requires X-Knauf-Api-Key header + ?email= query param.
//
// Response: { allowed: boolean }
'use strict';

const express = require('express');
const { requireJwtAuth } = require('~/server/middleware');
const requireKnaufApiKey = require('~/server/middleware/requireKnaufApiKey');
const { isEmailAllowed } = require('~/server/knauf/migrationAllowlist');

const router = express.Router();

// --- Frontend endpoint (JWT) ---
router.get('/', requireJwtAuth, async (req, res) => {
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
