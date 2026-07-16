// [knauf] KK20-195 WP4b — the bounded periodic reconciliation loop (hardened
// plan §8.4), run inside the dedicated worker process. Seven cases; each
// pass uses indexed, LIMITED queries and records counts. Reconciliation
// repairs only cases with an unambiguous safe action — otherwise it alerts
// (log at error level with a stable marker) and leaves state intact.
//
//   1. stale `uploading` asset      → no File reference: remove the dead
//                                     reservation (via the WP3d lifecycle);
//                                     referenced: alert (ambiguous).
//   2. expired `processing` lease   → claimable by design (§5.1 reclaims
//                                     them); long-expired leases mean no
//                                     worker is draining → alert only.
//   3. File → missing asset         → alert only (fabricating an asset or
//                                     deleting a user's row is never safe).
//   4. asset with no references     → repair: tombstone + physical cleanup +
//                                     remove (the WP3d lifecycle — same
//                                     §8.2/§8.3 guarantees).
//   5. `delete_failed` due for retry→ repair: retryDelete CAS → cleanup →
//                                     remove, or back to delete_failed.
//   6. `ready` without a generation → alert only (single-doc CAS should make
//                                     this impossible — data corruption).
//   7. migration inconsistency      → alert only (needs re-upload; WP2d
//                                     marked them failed deliberately).
//
// DI-style: `db` (createMethods), `listAssets`/`listFileAssetRefs` (bounded
// raw queries the methods surface doesn't expose — the worker wires mongoose
// models), and `cleanupAsset` (physical GC thunk) are injected.

const { gcAssetThroughLifecycle } = require('./fileAssetDelete');

/** @param {string | undefined} raw @param {number} fallback @returns {number} */
const envInt = (raw, fallback) => {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** @returns {Object} reconciler knobs, read at call time (env-tunable defaults) */
const getReconcilerConfig = () => ({
  batchLimit: envInt(process.env.KNAUF_RECONCILE_BATCH_LIMIT, 100),
  staleUploadingMs: envInt(process.env.KNAUF_RECONCILE_STALE_UPLOADING_MS, 60 * 60 * 1000),
  staleLeaseAlertMs: envInt(process.env.KNAUF_RECONCILE_STALE_LEASE_MS, 30 * 60 * 1000),
  orphanAssetMs: envInt(process.env.KNAUF_RECONCILE_ORPHAN_ASSET_MS, 24 * 60 * 60 * 1000),
  deleteRetryMs: envInt(process.env.KNAUF_RECONCILE_DELETE_RETRY_MS, 15 * 60 * 1000),
  intervalMs: envInt(process.env.KNAUF_RECONCILE_INTERVAL_MS, 15 * 60 * 1000),
});

/**
 * @param {Object} deps
 * @param {Object} deps.db - createMethods surface
 * @param {(filter: Object, limit: number) => Promise<Object[]>} deps.listAssets
 *   - bounded, lean KnaufFileAsset query (filters hit the §4.3 indexes)
 * @param {(limit: number) => Promise<Array<{ file_id: string, knauf_asset_id: string }>>} deps.listFileAssetRefs
 *   - most-recently-updated File rows carrying an asset pointer
 * @param {(asset: Object) => Promise<boolean>} deps.cleanupAsset
 *   - physical GC (vectors by asset id + blob); resolves true on confirmed cleanup
 * @param {{ info: Function, warn: Function, error: Function }} deps.logger
 * @returns {{ runOnce: Function, start: Function, stop: Function }}
 */
function createIndexingReconciler({ db, listAssets, listFileAssetRefs, cleanupAsset, logger }) {
  /** Alert = error-level log with a stable, grep/monitor-able marker. */
  const alert = (caseName, detail) =>
    logger.error(`[indexingReconciler][alert][${caseName}] ${detail}`);

  const hasReferences = async (asset_id) => {
    const rows = (await db.getFiles({ knauf_asset_id: asset_id }, null, { file_id: 1 })) ?? [];
    return rows.length > 0;
  };

  /** Case 1 — stale `uploading`: reservation whose request died before queueing. */
  const reconcileStaleUploading = async (config, now) => {
    const cutoff = new Date(now.getTime() - config.staleUploadingMs);
    const assets = await listAssets(
      { status: 'uploading', updatedAt: { $lte: cutoff }, delete_requested_at: null },
      config.batchLimit,
    );
    let repaired = 0;
    let alerted = 0;
    for (const asset of assets) {
      if (await hasReferences(asset.asset_id)) {
        // A File row pointing at an asset that never reached `queued` should
        // not exist (rows are created after markQueued) — never auto-delete.
        alert('stale_uploading_referenced', `asset ${asset.asset_id} has File references`);
        alerted += 1;
        continue;
      }
      const cleaned = await gcAssetThroughLifecycle({
        db,
        asset_id: asset.asset_id,
        logger,
        cleanup: () => cleanupAsset(asset),
      });
      cleaned ? (repaired += 1) : (alerted += 1);
    }
    return { scanned: assets.length, repaired, alerted };
  };

  /** Case 2 — long-expired `processing` leases: claimable, but nobody claims. */
  const reconcileExpiredLeases = async (config, now) => {
    const cutoff = new Date(now.getTime() - config.staleLeaseAlertMs);
    const assets = await listAssets(
      { status: 'processing', lease_expires_at: { $lte: cutoff } },
      config.batchLimit,
    );
    if (assets.length > 0) {
      // §5.1 reclaims expired leases naturally — leases THIS stale mean the
      // worker fleet is not draining. Repairing here would mask the outage.
      alert(
        'expired_lease_not_reclaimed',
        `${assets.length} processing asset(s) with leases expired > ${config.staleLeaseAlertMs}ms`,
      );
    }
    return { scanned: assets.length, repaired: 0, alerted: assets.length };
  };

  /** Case 3 — File rows pointing at a missing asset. */
  const reconcileDanglingFileRefs = async (config) => {
    const refs = await listFileAssetRefs(config.batchLimit);
    const assetIds = [...new Set(refs.map((r) => r.knauf_asset_id).filter(Boolean))];
    if (assetIds.length === 0) {
      return { scanned: 0, repaired: 0, alerted: 0 };
    }
    const found = new Set((await db.getAssetsByAssetIds(assetIds)).map((a) => a.asset_id));
    const dangling = refs.filter((r) => r.knauf_asset_id && !found.has(r.knauf_asset_id));
    for (const ref of dangling) {
      alert(
        'file_missing_asset',
        `file ${ref.file_id} points at missing asset ${ref.knauf_asset_id}`,
      );
    }
    return { scanned: refs.length, repaired: 0, alerted: dangling.length };
  };

  /** Case 4 — assets with no logical references (missed last-reference delete). */
  const reconcileOrphanAssets = async (config, now) => {
    const cutoff = new Date(now.getTime() - config.orphanAssetMs);
    const assets = await listAssets(
      {
        status: { $in: ['ready', 'failed'] },
        updatedAt: { $lte: cutoff },
        delete_requested_at: null,
      },
      config.batchLimit,
    );
    let repaired = 0;
    let alerted = 0;
    let kept = 0;
    for (const asset of assets) {
      if (await hasReferences(asset.asset_id)) {
        kept += 1;
        continue;
      }
      const cleaned = await gcAssetThroughLifecycle({
        db,
        asset_id: asset.asset_id,
        logger,
        cleanup: () => cleanupAsset(asset),
      });
      cleaned ? (repaired += 1) : (alerted += 1);
    }
    return { scanned: assets.length, repaired, alerted, kept };
  };

  /** Case 5 — `delete_failed` due for another attempt. */
  const reconcileDeleteFailed = async (config, now) => {
    const cutoff = new Date(now.getTime() - config.deleteRetryMs);
    const assets = await listAssets(
      { status: 'delete_failed', updatedAt: { $lte: cutoff } },
      config.batchLimit,
    );
    let repaired = 0;
    let alerted = 0;
    for (const asset of assets) {
      const resumed = await db.retryDelete({ asset_id: asset.asset_id });
      if (!resumed) {
        continue; // someone else transitioned it — fine
      }
      const cleaned = await cleanupAsset(asset);
      if (cleaned) {
        await db.removeAsset({ asset_id: asset.asset_id });
        repaired += 1;
      } else {
        await db.markDeleteFailed({
          asset_id: asset.asset_id,
          error_code: 'physical_cleanup_failed',
        });
        alert('delete_retry_failed', `asset ${asset.asset_id} cleanup failed again`);
        alerted += 1;
      }
    }
    return { scanned: assets.length, repaired, alerted };
  };

  /** Case 6 — `ready` without an active generation (should be impossible). */
  const reconcileReadyWithoutGeneration = async (config) => {
    const assets = await listAssets(
      { status: 'ready', active_generation: null },
      config.batchLimit,
    );
    for (const asset of assets) {
      alert(
        'ready_without_generation',
        `asset ${asset.asset_id} is ready with no active generation`,
      );
    }
    return { scanned: assets.length, repaired: 0, alerted: assets.length };
  };

  /** Case 7 — legacy migration inconsistencies (WP2d marked these failed). */
  const reconcileMigrationInconsistent = async (config) => {
    const assets = await listAssets(
      { status: 'failed', last_error_code: 'migration_inconsistent' },
      config.batchLimit,
    );
    if (assets.length > 0) {
      alert(
        'migration_inconsistent',
        `${assets.length} asset(s) need re-upload (legacy migration found partial state)`,
      );
    }
    return { scanned: assets.length, repaired: 0, alerted: assets.length };
  };

  /**
   * One bounded pass over all seven cases. Never throws — each case is
   * contained so one bad document cannot stall the rest.
   * @returns {Promise<Object>} per-case counts
   */
  const runOnce = async () => {
    const config = getReconcilerConfig();
    const now = new Date();
    const cases = {
      stale_uploading: (c, n) => reconcileStaleUploading(c, n),
      expired_lease: (c, n) => reconcileExpiredLeases(c, n),
      dangling_file_refs: (c) => reconcileDanglingFileRefs(c),
      orphan_assets: (c, n) => reconcileOrphanAssets(c, n),
      delete_failed: (c, n) => reconcileDeleteFailed(c, n),
      ready_without_generation: (c) => reconcileReadyWithoutGeneration(c),
      migration_inconsistent: (c) => reconcileMigrationInconsistent(c),
    };
    const counts = {};
    for (const [name, run] of Object.entries(cases)) {
      try {
        counts[name] = await run(config, now);
      } catch (error) {
        logger.warn(`[indexingReconciler] case ${name} failed: ${error?.message}`);
        counts[name] = { error: error?.message };
      }
    }
    logger.info(`[indexingReconciler] pass complete: ${JSON.stringify(counts)}`);
    return counts;
  };

  let timer = null;
  /** Schedule periodic passes (worker process only). */
  const start = () => {
    if (timer) {
      return;
    }
    const tick = () => {
      runOnce().catch((error) =>
        logger.error(`[indexingReconciler] pass crashed: ${error?.message}`),
      );
    };
    timer = setInterval(tick, getReconcilerConfig().intervalMs);
    timer.unref?.();
  };
  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { runOnce, start, stop };
}

module.exports = { createIndexingReconciler, getReconcilerConfig };
// End [knauf]
