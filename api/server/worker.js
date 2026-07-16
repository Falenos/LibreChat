// [knauf] KK20-195 WP4a — dedicated indexing-worker entry point (hardened
// plan §9.1): same application image as the API, separate process role. No
// public HTTP beyond a minimal health listener for platform probes. Runs the
// §5 claim loop under `runAsSystem` (File and KnaufFileAsset are
// tenant-isolated; the worker's scope comes from persisted rows, never a
// request). Gated by KNAUF_INDEXING_WORKER_ENABLED — plan §12 keeps
// acceptance and execution as independent switches.
//
// SIGTERM semantics (§5.2): stop claiming immediately, wait for in-flight
// work within the pod grace period, never release a lease mid-RAG — an
// unfinished claim expires and is reclaimed with a fresh token + generation.
require('./telemetry');
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..') });
const http = require('http');
const mongoose = require('mongoose');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const { initializeFileStorage } = require('@librechat/api');
const { connectDb } = require('~/db');
const { getAppConfig } = require('~/server/services/Config');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { isIndexingWorkerEnabled } = require('~/server/services/Files/knauf/asyncIndexingConfig');
const { createIndexingWorker } = require('~/server/services/Files/knauf/indexingWorker');
const { createGenerationRagClient } = require('~/server/services/Files/knauf/generationRagClient');
const db = require('~/models');

const WORKER_PORT = Number.parseInt(process.env.KNAUF_WORKER_PORT ?? '', 10) || 3081;
const SHUTDOWN_GRACE_MS = Number.parseInt(process.env.KNAUF_WORKER_GRACE_MS ?? '', 10) || 60_000;

/**
 * Persisted retrieval scope for one claimed asset (plan §9.1 / assumption
 * ledger #6): the owning user comes from a surviving File row; agent assets
 * embed under the agent id, chat assets under the user id.
 */
const resolveScope = async (claim) => {
  const rows = await db.getFiles({ knauf_asset_id: claim.asset_id }, null, { user: 1 });
  const row = rows?.[0];
  if (!row?.user) {
    return null;
  }
  const userId = String(row.user);
  return {
    userId,
    entityId: claim.scope_type === 'agent' ? claim.scope_id : userId,
  };
};

/** WP2c lockstep: activation flips File.embedded for every referencing row. */
const markFilesEmbedded = (asset_id) =>
  mongoose.models.File.updateMany({ knauf_asset_id: asset_id }, { $set: { embedded: true } });

const main = async () => {
  if (!isIndexingWorkerEnabled()) {
    logger.warn('[worker] KNAUF_INDEXING_WORKER_ENABLED is not true — exiting cleanly');
    process.exit(0);
  }

  await connectDb();
  logger.info('[worker] Connected to MongoDB');
  const appConfig = await getAppConfig({ baseOnly: true });
  initializeFileStorage(appConfig);

  const worker = createIndexingWorker({
    db,
    ragClient: createGenerationRagClient({ getStrategyFunctions }),
    resolveScope,
    markFilesEmbedded,
    logger,
  });

  const health = http
    .createServer((req, res) => {
      res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'text/plain' });
      res.end('ok');
    })
    .listen(WORKER_PORT, () => logger.info(`[worker] health listener on :${WORKER_PORT}`));

  const loop = runAsSystem(() => worker.start());

  const shutdown = (signal) => {
    logger.info(`[worker] ${signal} received — stop claiming, draining in-flight work`);
    worker.stop();
    health.close();
    const hardExit = setTimeout(() => {
      logger.error('[worker] grace period elapsed with work still in flight — exiting');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    hardExit.unref?.();
    loop.finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await loop;
  process.exit(0);
};

if (require.main === module) {
  main().catch((error) => {
    logger.error('[worker] fatal startup error:', error);
    process.exit(1);
  });
}

module.exports = { resolveScope, markFilesEmbedded };
// End [knauf]
