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
const agentCategories = require('./agentCategories');
const analyticsDiagnostics = require('./analyticsDiagnostics');
const autogeneratePrompt = require('./autogeneratePrompt');
const costs = require('./costs');
const promptTemplates = require('./promptTemplates');
const artifactExport = require('./artifactExport');
const artifactContinuation = require('./artifactContinuation');
const artifactRevisions = require('./artifactRevisions');
// [knauf] Migration access gate — public endpoint queried by the frontend after Okta login.
const migrationAccess = require('./migrationAccess');
// End [knauf]
// [knauf] KK20-195 WP2 — FileAsset backfill trigger (X-Knauf-Api-Key guarded).
const fileAssetMigration = require('./fileAssetMigration');
// End [knauf]

const router = express.Router();
router.use('/agent-categories', agentCategories);
router.use('/analytics', analyticsDiagnostics);
router.use('/autogenerate-prompt', autogeneratePrompt);
router.use('/costs', costs);
router.use('/prompt-templates', promptTemplates);
router.use('/artifact-export', artifactExport);
router.use('/artifact-continuation', artifactContinuation);
router.use('/artifact-revisions', artifactRevisions);
// [knauf] Mount migration access check endpoint.
router.use('/migration/access', migrationAccess);
// End [knauf]
// [knauf] KK20-195 WP2 — mount the FileAsset backfill trigger.
router.use('/migration/file-assets', fileAssetMigration);
// End [knauf]

module.exports = router;
