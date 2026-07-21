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
const { createProbeApp, evaluateReadiness } = require('~/server/services/Files/knauf/workerProbes');
const mongoose = require('mongoose');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const {
  initializeFileStorage,
  createMetrics,
  recordFileIndexWorkerClaim,
  recordFileIndexWorkerQueue,
} = require('@librechat/api');
const { connectDb } = require('~/db');
const { getAppConfig } = require('~/server/services/Config');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { isIndexingWorkerEnabled } = require('~/server/services/Files/knauf/asyncIndexingConfig');
const {
  createQueueMetricsSampler,
  createIndexingWorker,
  generationsToClean,
  getWorkerConfig,
} = require('~/server/services/Files/knauf/indexingWorker');
const {
  createIndexingReconciler,
  getReconcilerConfig,
} = require('~/server/services/Files/knauf/indexingReconciler');
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

/**
 * KK20-195 review — the owning user for an asset's RAG token and blob deletion:
 * user-scope embeds under the user id (scope_id IS the user), agent-scope under
 * a referencing File's user (scope_id is the AGENT id, not a user).
 */
const resolveOwnerUserId = async (asset) => {
  if (asset.scope_type === 'user') {
    return asset.scope_id;
  }
  const rows = await db.getFiles({ knauf_asset_id: asset.asset_id }, null, { user: 1 });
  // Fall back to the agent id (scope_id) as a last-resort authenticated subject
  // when no File row survives (an agent-scoped orphan): an UNauthenticated
  // delete 401s and churns forever in delete_failed. A signed token is what
  // rag_api requires; WP1 should persist an owner_user_id on the asset so the
  // subject is exact rather than the agent id.
  return rows?.[0]?.user ? String(rows[0].user) : asset.scope_id;
};

// WP4b — bounded raw queries the createMethods surface doesn't expose; the
// reconciler injects limits so every pass stays indexed and finite (§8.4).
const listAssets = (filter, limit, sort = { updatedAt: 1 }) =>
  mongoose.models.KnaufFileAsset.find(filter).sort(sort).limit(limit).lean();
// KK20-195 review F7 — full indexed count for the alert-only cases, so their
// reported metric is complete (never truncated at batchLimit) and restart-safe.
const countAssets = (filter) => mongoose.models.KnaufFileAsset.countDocuments(filter);
// KK20-195 review R8 — rotating _id cursor (afterId) so the dangling-refs
// sweep converges over the WHOLE File space across passes instead of
// re-reading the same most-recently-updated window forever.
const listFileAssetRefs = (limit, afterId = null) =>
  mongoose.models.File.find({
    knauf_asset_id: { $exists: true, $ne: null },
    ...(afterId != null ? { _id: { $gt: afterId } } : {}),
  })
    .sort({ _id: 1 })
    .limit(limit)
    .select({ file_id: 1, knauf_asset_id: 1, knauf_upload_finalized: 1 })
    .lean();

/**
 * WP4b physical cleanup for reconciler-owned deletions (§8.2: the deletion
 * owner removes the vectors, then the blob). Vector deletion goes through
 * the generation client; the "every generation" endpoint lands with WP1 —
 * until then the known generations cover assets this system created.
 */
const buildCleanupAsset = (ragClient) => async (asset) => {
  let cleaned = true;
  const ownerUserId = await resolveOwnerUserId(asset);
  // KK20-195 review R9 — recorded cleanup debt is part of the deletion set: a
  // failed attempt's generation must not outlive the asset. F8 (re-review):
  // generationsToClean keeps generation 0 (the sync/migration label) so those
  // vectors are cleaned too — the earlier `g > 0` filter leaked them.
  const generations = generationsToClean(asset);
  for (const generation of generations) {
    try {
      await ragClient.deleteGeneration({
        asset_id: asset.asset_id,
        generation,
        vector_backend: asset.vector_backend,
        userId: ownerUserId,
      });
    } catch (error) {
      cleaned = false;
      logger.warn(
        `[worker] vector cleanup failed for ${asset.asset_id}:${generation}: ${error?.message}`,
      );
    }
  }
  if (asset.blob?.path) {
    try {
      const { deleteFile } = getStrategyFunctions(asset.blob.source ?? 'local');
      await deleteFile(
        { user: { id: ownerUserId ?? asset.scope_id } },
        {
          file_id: asset.asset_id,
          filepath: asset.blob.path,
          source: asset.blob.source,
          embedded: false,
        },
      );
    } catch (error) {
      cleaned = false;
      logger.warn(`[worker] blob cleanup failed for ${asset.asset_id}: ${error?.message}`);
    }
  }
  return cleaned;
};

const main = async () => {
  if (!isIndexingWorkerEnabled()) {
    logger.warn('[worker] KNAUF_INDEXING_WORKER_ENABLED is not true — exiting cleanly');
    process.exit(0);
  }

  await connectDb();
  logger.info('[worker] Connected to MongoDB');
  const appConfig = await getAppConfig({ baseOnly: true });
  initializeFileStorage(appConfig);

  const ragClient = createGenerationRagClient({ getStrategyFunctions });
  const worker = createIndexingWorker({
    db,
    ragClient,
    resolveScope,
    markFilesEmbedded,
    logger,
    // KK20-195 review R11 — claim outcomes → knauf_file_index_worker_claims_total.
    recordClaimOutcome: recordFileIndexWorkerClaim,
  });
  const reconciler = createIndexingReconciler({
    db,
    listAssets,
    countAssets,
    listFileAssetRefs,
    cleanupAsset: buildCleanupAsset(ragClient),
    // KK20-195 review R9 — the debt-drain case deletes ONE generation with
    // the owning user's identity resolved from persisted rows.
    deleteGeneration: async (asset, generation) =>
      ragClient.deleteGeneration({
        asset_id: asset.asset_id,
        generation,
        vector_backend: asset.vector_backend,
        userId: await resolveOwnerUserId(asset),
      }),
    logger,
  });

  // KK20-195 review R11 — the probe surface tells the TRUTH (see workerProbes.js).
  // Readiness tolerates a valid long-running claim: progress is a loop tick OR
  // a live heartbeat, and the staleness window covers both idle polling and the
  // heartbeat cadence, so an embed/OCR job longer than the poll interval keeps
  // /ready green. /metrics is mounted at /metrics (the router serves at '/').
  const { metricsRouter } = createMetrics();
  const probeApp = createProbeApp({
    metricsRouter,
    getReadiness: () => {
      const config = getWorkerConfig();
      // Tolerate the slower of idle polling and the heartbeat cadence, with
      // headroom for jitter — only a genuinely wedged loop trips this.
      const staleAfterMs = Math.max(5 * config.pollMs, 3 * config.heartbeatMs);
      const lastProgressAgoMs = Date.now() - worker.getLastProgressAt();
      const mongoConnected = mongoose.connection.readyState === 1;
      return {
        ready: evaluateReadiness({ mongoConnected, lastProgressAgoMs, staleAfterMs }),
        detail: { mongo: mongoConnected, loop_last_progress_ms_ago: lastProgressAgoMs },
      };
    },
  });
  const health = probeApp.listen(WORKER_PORT, () =>
    logger.info(`[worker] health/ready/metrics listener on :${WORKER_PORT}`),
  );

  const loop = runAsSystem(() => worker.start());
  const queueMetrics = createQueueMetricsSampler({
    sample: () =>
      runAsSystem(async () => {
        const [queued, oldest] = await Promise.all([
          mongoose.models.KnaufFileAsset.countDocuments({ status: 'queued' }),
          mongoose.models.KnaufFileAsset.findOne({ status: 'queued' })
            .sort({ queued_at: 1 })
            .select({ queued_at: 1 })
            .lean(),
        ]);
        return {
          queued,
          oldestAgeSeconds: oldest?.queued_at
            ? Math.max(0, (Date.now() - new Date(oldest.queued_at).getTime()) / 1000)
            : 0,
        };
      }),
    record: recordFileIndexWorkerQueue,
    logger,
  });
  queueMetrics.start();
  // Reconciler scheduling lives HERE (not reconciler.start()): interval
  // callbacks escape the AsyncLocalStorage context, so every pass must be
  // re-wrapped in runAsSystem for the tenant-isolated models.
  const reconcilePass = () =>
    runAsSystem(() => reconciler.runOnce()).catch((error) =>
      logger.error('[worker] reconciliation pass failed:', error),
    );
  reconcilePass(); // one pass at boot: recover from crashes fast
  const reconcileTimer = setInterval(reconcilePass, getReconcilerConfig().intervalMs);
  reconcileTimer.unref?.();

  const shutdown = (signal) => {
    logger.info(`[worker] ${signal} received — stop claiming, draining in-flight work`);
    worker.stop();
    queueMetrics.stop();
    clearInterval(reconcileTimer);
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
