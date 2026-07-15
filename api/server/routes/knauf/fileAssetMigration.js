// [knauf] KK20-195 WP2 — on-demand FileAsset backfill trigger.
// POST /api/knauf/migration/file-assets  { batchSize?, resumeAfterId?, dryRun? }
// Guarded by the shared X-Knauf-Api-Key middleware (same as the migration
// allowlist endpoints); each call migrates ONE bounded batch and returns the
// resume cursor, so the operator loop — not one long request — drives the
// full backfill. Runs under runAsSystem: there is no user request context and
// File/KnaufFileAsset are tenant-isolated.
const express = require('express');
const { runAsSystem } = require('@librechat/data-schemas');
const mongoose = require('mongoose');
const requireKnaufApiKey = require('~/server/middleware/requireKnaufApiKey');
const { migrateFileAssetsBatch } = require('~/server/services/Files/knauf/fileAssetMigration');

const router = express.Router();
router.use(requireKnaufApiKey);

router.post('/', express.json({ limit: '10kb' }), async (req, res) => {
  try {
    const { batchSize, resumeAfterId, dryRun } = req.body ?? {};
    const result = await runAsSystem(() =>
      migrateFileAssetsBatch({
        mongoose,
        batchSize: Number.isInteger(batchSize) && batchSize > 0 ? batchSize : undefined,
        resumeAfterId: typeof resumeAfterId === 'string' ? resumeAfterId : undefined,
        dryRun: dryRun === true,
      }),
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'file_asset_migration_failed', message: error.message });
  }
});

module.exports = router;
// End [knauf]
