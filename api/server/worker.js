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
const telemetry = require('./telemetry');
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
  recordFileTranslationOutcome,
  recordFileTranslationQueue,
  recordFileTranslationWorkerError,
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
  createMongoReconcilerLease,
  getReconcilerConfig,
} = require('~/server/services/Files/knauf/indexingReconciler');
const { createGenerationRagClient } = require('~/server/services/Files/knauf/generationRagClient');
const { IdmlError } = require('~/server/services/Files/knauf/idml/core');
const { translateFiles } = require('~/server/services/Files/knauf/translation/tool');
const {
  assertTranslationWriteFence,
  getTranslationJobConfig,
  getTranslationJobModel,
  prepareTranslationStorageLocator,
  translationArgsForJob,
} = require('~/server/services/Files/knauf/translation/jobs');
const {
  createTranslationOutputCleanup,
  createTranslationWorker,
} = require('~/server/services/Files/knauf/translation/worker');
const {
  shutdownTranslationObservability,
} = require('~/server/services/Files/knauf/translation/observability');
const {
  deleteFilesWithDedupAwareness,
} = require('~/server/services/Files/knauf/cascadeDeleteConvoFiles');
const db = require('~/models');

const WORKER_PORT = Number.parseInt(process.env.KNAUF_WORKER_PORT ?? '', 10) || 3081;
const SHUTDOWN_GRACE_MS = Number.parseInt(process.env.KNAUF_WORKER_GRACE_MS ?? '', 10) || 60_000;
const isTranslationWorkerEnabled = () =>
  process.env.KNAUF_FILE_TRANSLATION_WORKER_ENABLED === 'true';

const translationFailure = (report) => {
  const failure = report?.files?.find((file) => file.status === 'failed') ?? {};
  const statusByCode = {
    translator_rate_limited: 429,
    translator_timeout: 504,
    translator_auth_failed: 401,
    translator_rejected: 400,
    translator_failed: 502,
    translation_transport_failed: 503,
    azure_translator_unconfigured: 503,
    azure_storage_unconfigured: 503,
    storage_read_failed: 503,
    storage_write_failed: 503,
    glossary_revision_unavailable: 503,
    glossary_revision_mismatch: 503,
  };
  const error = new IdmlError(
    failure.error ?? 'Translation job produced no output',
    failure.code ?? 'translation_failed',
    statusByCode[failure.code] ?? 422,
  );
  error.retryAfter = failure.retryAfter;
  error.protectedTermsRequired = Boolean(failure.protectedTermsRequired);
  return error;
};

const buildTranslationRequest = (job, appConfig) => {
  const req = {
    user: { id: job.user, tenantId: job.tenantId ?? undefined },
    config: appConfig,
    body: {
      conversationId: job.conversation_id ?? undefined,
      files: job.input_files,
    },
  };
  req.knaufTranslationWriteFence = ({ outputFileId }) =>
    assertTranslationWriteFence({
      jobId: job.job_id,
      token: job.execution_token,
      generation: job.target_generation,
      outputFileId,
    });
  req.knaufTranslationPrepareStorageLocator = (locator) =>
    prepareTranslationStorageLocator({
      jobId: job.job_id,
      token: job.execution_token,
      generation: job.target_generation,
      locator,
    });
  if (job.output_retention_resolved === true) {
    req.knaufTranslationOutputExpiresAt = job.output_expires_at ?? null;
  }
  return req;
};

const cleanupRequest = (job) => ({
  user: { id: job.user, tenantId: job.tenantId ?? undefined },
  body: {},
});

const cleanupTranslationOutputs = createTranslationOutputCleanup({
  findFiles: (fileIds, job) =>
    db.getFiles({
      file_id: { $in: fileIds },
      user: job.user,
      ...(job.tenantId ? { tenantId: job.tenantId } : {}),
    }),
  deletePersistedFiles: (files, job) =>
    deleteFilesWithDedupAwareness({ req: cleanupRequest(job), files }),
  deleteLocatedOutput: (locator, job) =>
    deleteFilesWithDedupAwareness({
      req: cleanupRequest(job),
      files: [
        {
          ...locator,
          user: job.user,
          tenantId: job.tenantId ?? null,
          embedded: false,
        },
      ],
    }),
});

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
  const indexingEnabled = isIndexingWorkerEnabled();
  const translationEnabled = isTranslationWorkerEnabled();
  if (!indexingEnabled && !translationEnabled) {
    logger.warn('[worker] no worker role is enabled — exiting cleanly');
    process.exit(0);
  }

  await connectDb();
  logger.info('[worker] Connected to MongoDB');
  const appConfig = await getAppConfig({ baseOnly: true });
  initializeFileStorage(appConfig);

  const ragClient = indexingEnabled ? createGenerationRagClient({ getStrategyFunctions }) : null;
  const reconcilerConfig = indexingEnabled ? getReconcilerConfig() : null;
  const acquireReconcilerLease = indexingEnabled
    ? createMongoReconcilerLease({
        collection: mongoose.connection.db.collection('knauf_file_indexing_locks'),
        ownerId: process.env.HOSTNAME ?? `worker-${process.pid}`,
        leaseMs: 2 * reconcilerConfig.intervalMs,
      })
    : null;
  const worker = indexingEnabled
    ? createIndexingWorker({
        db,
        ragClient,
        resolveScope,
        markFilesEmbedded,
        logger,
        // KK20-195 review R11 — claim outcomes → knauf_file_index_worker_claims_total.
        recordClaimOutcome: recordFileIndexWorkerClaim,
      })
    : null;
  const translationWorker = translationEnabled
    ? createTranslationWorker({
        logger,
        execute: async (job, signal) => {
          const result = await translateFiles({
            req: buildTranslationRequest(job, appConfig),
            args: translationArgsForJob(job),
            signal,
            expectedGlossaryRevision: job.glossary_revision,
          });
          if (result.report.status === 'failed') {
            throw translationFailure(result.report);
          }
          return result;
        },
        cleanupOutputs: cleanupTranslationOutputs,
        onOutcome: recordFileTranslationOutcome,
        onWorkerError: recordFileTranslationWorkerError,
      })
    : null;
  const reconciler = indexingEnabled
    ? createIndexingReconciler({
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
        acquireRunLease: acquireReconcilerLease,
      })
    : null;

  // KK20-195 review R11 — the probe surface tells the TRUTH (see workerProbes.js).
  // Readiness tolerates a valid long-running claim: progress is a loop tick OR
  // a live heartbeat, and the staleness window covers both idle polling and the
  // heartbeat cadence, so an embed/OCR job longer than the poll interval keeps
  // /ready green. /metrics is mounted at /metrics (the router serves at '/').
  const { metricsRouter } = createMetrics();
  const probeApp = createProbeApp({
    metricsRouter,
    getReadiness: () => {
      const indexConfig = indexingEnabled ? getWorkerConfig() : null;
      const translationConfig = translationEnabled ? getTranslationJobConfig() : null;
      // Tolerate the slower of idle polling and the heartbeat cadence, with
      // headroom for jitter — only a genuinely wedged loop trips this.
      const staleAfterMs = Math.max(
        indexConfig ? 5 * indexConfig.pollMs : 0,
        indexConfig ? 3 * indexConfig.heartbeatMs : 0,
        translationConfig ? 5 * translationConfig.pollMs : 0,
        translationConfig ? 3 * translationConfig.heartbeatMs : 0,
      );
      const indexingProgressAgoMs = worker ? Date.now() - worker.getLastProgressAt() : 0;
      const translationProgressAgoMs = translationWorker
        ? Date.now() - translationWorker.getLastProgressAt()
        : 0;
      const lastProgressAgoMs = Math.max(indexingProgressAgoMs, translationProgressAgoMs);
      const mongoConnected = mongoose.connection.readyState === 1;
      return {
        ready: evaluateReadiness({ mongoConnected, lastProgressAgoMs, staleAfterMs }),
        detail: {
          mongo: mongoConnected,
          loop_last_progress_ms_ago: indexingProgressAgoMs,
          translation_loop_last_progress_ms_ago: translationProgressAgoMs,
        },
      };
    },
  });
  const health = probeApp.listen(WORKER_PORT, () =>
    logger.info(`[worker] health/ready/metrics listener on :${WORKER_PORT}`),
  );

  const loop = worker ? runAsSystem(() => worker.start()) : Promise.resolve();
  const translationLoop = translationWorker
    ? runAsSystem(() => translationWorker.start())
    : Promise.resolve();
  const queueMetrics = indexingEnabled
    ? createQueueMetricsSampler({
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
      })
    : null;
  queueMetrics?.start();
  let translationActive = 0;
  let translationCleanupPending = 0;
  let translationOldestCleanupAgeSeconds = 0;
  const translationQueueMetrics = translationWorker
    ? createQueueMetricsSampler({
        sample: () =>
          runAsSystem(async () => {
            const Model = getTranslationJobModel();
            const [queued, active, oldest, cleanupPending, oldestCleanupRows] = await Promise.all([
              Model.countDocuments({ status: { $in: ['queued', 'retrying'] } }),
              Model.countDocuments({ active: true }),
              Model.findOne({ status: { $in: ['queued', 'retrying'] } })
                .sort({ queued_at: 1 })
                .select({ queued_at: 1 })
                .lean(),
              Model.countDocuments({
                attempt_outputs: { $elemMatch: { cleanup_status: 'cleanup_pending' } },
              }),
              Model.aggregate([
                { $unwind: '$attempt_outputs' },
                {
                  $match: {
                    'attempt_outputs.cleanup_status': 'cleanup_pending',
                    'attempt_outputs.cleanup_after': { $ne: null },
                  },
                },
                { $sort: { 'attempt_outputs.cleanup_after': 1 } },
                { $limit: 1 },
                { $project: { cleanup_after: '$attempt_outputs.cleanup_after' } },
              ]),
            ]);
            translationActive = active;
            translationCleanupPending = cleanupPending;
            const oldestCleanupAt = oldestCleanupRows[0]?.cleanup_after;
            translationOldestCleanupAgeSeconds = oldestCleanupAt
              ? Math.max(0, (Date.now() - new Date(oldestCleanupAt).getTime()) / 1000)
              : 0;
            return {
              queued,
              oldestAgeSeconds: oldest?.queued_at
                ? Math.max(0, (Date.now() - new Date(oldest.queued_at).getTime()) / 1000)
                : 0,
            };
          }),
        record: (queued, oldestAgeSeconds) =>
          recordFileTranslationQueue(
            queued,
            translationActive,
            oldestAgeSeconds,
            translationCleanupPending,
            translationOldestCleanupAgeSeconds,
          ),
        onError: () => recordFileTranslationWorkerError('queue_sample'),
        logger,
      })
    : null;
  translationQueueMetrics?.start();
  // Reconciler scheduling lives HERE (not reconciler.start()): interval
  // callbacks escape the AsyncLocalStorage context, so every pass must be
  // re-wrapped in runAsSystem for the tenant-isolated models.
  const reconcilePass = reconciler
    ? () =>
        runAsSystem(() => reconciler.runOnce()).catch((error) =>
          logger.error('[worker] reconciliation pass failed:', error),
        )
    : null;
  reconcilePass?.(); // one pass at boot: recover from crashes fast
  const reconcileTimer = reconcilePass
    ? setInterval(reconcilePass, reconcilerConfig.intervalMs)
    : null;
  reconcileTimer?.unref?.();
  const translationReconcilePass = translationWorker
    ? () =>
        runAsSystem(() => translationWorker.reconcileOnce()).catch((error) =>
          logger.error('[worker] translation reconciliation pass failed:', error),
        )
    : null;
  translationReconcilePass?.();
  const translationReconcileTimer = translationReconcilePass
    ? setInterval(translationReconcilePass, getTranslationJobConfig().reconcileIntervalMs)
    : null;
  translationReconcileTimer?.unref?.();

  const shutdown = (signal) => {
    logger.info(`[worker] ${signal} received — stop claiming, draining in-flight work`);
    worker?.stop();
    translationWorker?.stop();
    queueMetrics?.stop();
    translationQueueMetrics?.stop();
    if (reconcileTimer) clearInterval(reconcileTimer);
    if (translationReconcileTimer) clearInterval(translationReconcileTimer);
    health.close();
    const hardExit = setTimeout(() => {
      logger.error('[worker] grace period elapsed with work still in flight — exiting');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    hardExit.unref?.();
    Promise.allSettled([loop, translationLoop]).finally(async () => {
      await Promise.allSettled([telemetry.shutdown(), shutdownTranslationObservability(logger)]);
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await Promise.all([loop, translationLoop]);
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
