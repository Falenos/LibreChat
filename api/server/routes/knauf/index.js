/**
 * Knauf-only Express router. Mounted under `/api/knauf` from
 * api/server/index.js (single [knauf] line).
 *
 * Routes are purely additive — they don't touch upstream's existing
 * controllers or middleware chain beyond using the standard
 * `requireJwtAuth`. New Knauf-specific endpoints (e.g. internal lookups,
 * compliance hooks) can be added inside this folder without further
 * upstream marker work.
 */
const express = require('express');
const analyticsDiagnostics = require('./analyticsDiagnostics');
const autogeneratePrompt = require('./autogeneratePrompt');

const router = express.Router();
router.use('/analytics', analyticsDiagnostics);
router.use('/autogenerate-prompt', autogeneratePrompt);

module.exports = router;
