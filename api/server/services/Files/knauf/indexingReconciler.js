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
 * @param {(filter: Object) => Promise<number>} deps.countAssets
 *   - full indexed countDocuments (F7: alert-only cases report the COMPLETE
 *     count so the metric is never truncated at batchLimit or lost on restart)
 * @param {(limit: number) => Promise<Array<{ file_id: string, knauf_asset_id: string }>>} deps.listFileAssetRefs
 *   - most-recently-updated File rows carrying an asset pointer
 * @param {(asset: Object) => Promise<boolean>} deps.cleanupAsset
 *   - physical GC (vectors by asset id + blob); resolves true on confirmed cleanup
 * @param {{ info: Function, warn: Function, error: Function }} deps.logger
 * @returns {{ runOnce: Function }}
 */
function createIndexingReconciler({
  db,
  listAssets,
  countAssets,
  listFileAssetRefs,
  cleanupAsset,
  deleteGeneration,
  logger,
}) {
  /** Alert = error-level log with a stable, grep/monitor-able marker. */
  const alert = (caseName, detail) =>
    logger.error(`[indexingReconciler][alert][${caseName}] ${detail}`);

  // KK20-195 review — one $in query answers references for a whole batch
  // instead of a point query per asset (the §4.3 File.knauf_asset_id partial
  // index covers it), so a pass is O(cases) round trips, not O(batchLimit).
  const referencedAssetIds = async (assetIds) => {
    if (assetIds.length === 0) {
      return new Set();
    }
    const rows =
      (await db.getFiles({ knauf_asset_id: { $in: assetIds } }, null, { knauf_asset_id: 1 })) ?? [];
    return new Set(rows.map((r) => r.knauf_asset_id));
  };

  // KK20-195 review R8 — rotating _id cursors so every bounded case sweeps
  // its WHOLE space over successive passes. Rows the pass deliberately leaves
  // in place (referenced/alert-only ones) keep their sort position, so a
  // sort-from-the-beginning window would re-select the same batch forever and
  // starve everything behind it. Advancing by _id guarantees progress; a
  // short page means the sweep reached the end → wrap to the start.
  const makeRotatingCursor = () => {
    let cursorId = null;
    return {
      /** Decorate a filter with the cursor position. */
      apply: (filter) => (cursorId != null ? { ...filter, _id: { $gt: cursorId } } : filter),
      /** Advance past this page (or wrap when the space is exhausted). */
      advance: (rows, batchLimit) => {
        cursorId = rows.length < batchLimit ? null : rows.at(-1)._id;
      },
    };
  };
  const staleUploadingCursor = makeRotatingCursor();
  const orphanCursor = makeRotatingCursor();
  const deleteSweepCursor = makeRotatingCursor();
  let danglingRefsAfterId = null;
  // KK20-195 review F7 (re-review) — cursors for the alert-only cases 2, 6, 7
  // (previously they read only the first page, so records beyond batchLimit were
  // never observed).
  const expiredLeaseCursor = makeRotatingCursor();
  const readyWithoutGenCursor = makeRotatingCursor();
  const migrationInconsistentCursor = makeRotatingCursor();

  /**
   * KK20-195 review F7 (re-review) — shared body for the ALERT-ONLY cases (2, 6,
   * 7), with two independent guarantees:
   *   • completeness (restart-safe): the reported `total` is a full indexed
   *     countDocuments, so it is never truncated at batchLimit and needs no
   *     cursor state to be correct — a redeploy cannot lose it.
   *   • convergence: a rotating _id cursor advances a bounded detail sample
   *     across successive passes, so every offending record is eventually named
   *     for triage even when the backlog exceeds batchLimit.
   * @param {Object} p
   * @param {string} p.caseName
   * @param {Object} p.filter
   * @param {ReturnType<typeof makeRotatingCursor>} p.cursor
   * @param {Object} p.config
   * @param {(total: number) => string} p.summarize - the aggregate alert line
   * @param {(asset: Object) => string} p.describe - one detail line per sampled asset
   */
  const reconcileAlertOnly = async ({ caseName, filter, cursor, config, summarize, describe }) => {
    const total = await countAssets(filter);
    const page = await listAssets(cursor.apply(filter), config.batchLimit, { _id: 1 });
    cursor.advance(page, config.batchLimit);
    if (total > 0) {
      alert(caseName, summarize(total));
      for (const asset of page) {
        alert(caseName, describe(asset));
      }
    }
    return { scanned: page.length, total, repaired: 0, alerted: total };
  };

  /** Case 1 — stale `uploading`: reservation whose request died before queueing. */
  const reconcileStaleUploading = async (config, now) => {
    const cutoff = new Date(now.getTime() - config.staleUploadingMs);
    const assets = await listAssets(
      staleUploadingCursor.apply({
        status: 'uploading',
        updatedAt: { $lte: cutoff },
        delete_requested_at: null,
      }),
      config.batchLimit,
      { _id: 1 },
    );
    staleUploadingCursor.advance(assets, config.batchLimit);
    const referenced = await referencedAssetIds(assets.map((a) => a.asset_id));
    let repaired = 0;
    let alerted = 0;
    for (const asset of assets) {
      if (referenced.has(asset.asset_id)) {
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
  const reconcileExpiredLeases = (config, now) => {
    const cutoff = new Date(now.getTime() - config.staleLeaseAlertMs);
    // §5.1 reclaims expired leases naturally — leases THIS stale mean the worker
    // fleet is not draining. Repairing here would mask the outage → alert only.
    return reconcileAlertOnly({
      caseName: 'expired_lease_not_reclaimed',
      filter: { status: 'processing', lease_expires_at: { $lte: cutoff } },
      cursor: expiredLeaseCursor,
      config,
      summarize: (total) =>
        `${total} processing asset(s) with leases expired > ${config.staleLeaseAlertMs}ms`,
      describe: (asset) =>
        `asset ${asset.asset_id} lease expired at ${asset.lease_expires_at?.toISOString?.() ?? asset.lease_expires_at}`,
    });
  };

  /** Case 3 — File rows pointing at a missing asset. */
  const reconcileDanglingFileRefs = async (config) => {
    // R8 — rotating cursor over the File space (alert-only case: nothing here
    // changes rows, so a fixed window would re-read the same refs forever).
    const refs = await listFileAssetRefs(config.batchLimit, danglingRefsAfterId);
    danglingRefsAfterId = refs.length < config.batchLimit ? null : refs.at(-1)._id;
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
      orphanCursor.apply({
        status: { $in: ['ready', 'failed'] },
        updatedAt: { $lte: cutoff },
        delete_requested_at: null,
      }),
      config.batchLimit,
      { _id: 1 },
    );
    // Advance the cursor so kept (referenced) assets don't freeze the window.
    orphanCursor.advance(assets, config.batchLimit);
    const referenced = await referencedAssetIds(assets.map((a) => a.asset_id));
    let repaired = 0;
    let alerted = 0;
    let kept = 0;
    for (const asset of assets) {
      if (referenced.has(asset.asset_id)) {
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
    // KK20-195 review R4 — stale 'deleting' is swept too: the deletion owner
    // is a request that can die mid-delete (and R4's pre-tombstone can leave
    // a tombstoned asset behind when part of the physical delete failed and
    // rows survived). A tombstoned asset that still HAS references is the
    // partial-failure signature → alert, never auto-destroy.
    const assets = await listAssets(
      deleteSweepCursor.apply({
        status: { $in: ['delete_failed', 'deleting'] },
        updatedAt: { $lte: cutoff },
      }),
      config.batchLimit,
      { _id: 1 },
    );
    deleteSweepCursor.advance(assets, config.batchLimit);
    const referenced = await referencedAssetIds(assets.map((a) => a.asset_id));
    let repaired = 0;
    let alerted = 0;
    for (const asset of assets) {
      if (referenced.has(asset.asset_id)) {
        alert(
          'tombstoned_with_references',
          `asset ${asset.asset_id} is ${asset.status} but File rows still reference it (partial delete failure)`,
        );
        alerted += 1;
        continue;
      }
      if (asset.status === 'delete_failed') {
        const resumed = await db.retryDelete({ asset_id: asset.asset_id });
        if (!resumed) {
          continue; // someone else transitioned it — fine
        }
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
  const reconcileReadyWithoutGeneration = (config) =>
    reconcileAlertOnly({
      caseName: 'ready_without_generation',
      filter: { status: 'ready', active_generation: null },
      cursor: readyWithoutGenCursor,
      config,
      summarize: (total) => `${total} ready asset(s) with no active generation`,
      describe: (asset) => `asset ${asset.asset_id} is ready with no active generation`,
    });

  /** Case 7 — legacy migration inconsistencies (WP2d marked these failed). */
  const reconcileMigrationInconsistent = (config) =>
    reconcileAlertOnly({
      caseName: 'migration_inconsistent',
      filter: { status: 'failed', last_error_code: 'migration_inconsistent' },
      cursor: migrationInconsistentCursor,
      config,
      summarize: (total) =>
        `${total} asset(s) need re-upload (legacy migration found partial state)`,
      describe: (asset) => `asset ${asset.asset_id} needs re-upload (migration_inconsistent)`,
    });

  /**
   * Case 8 (KK20-195 review R9) — drain cleanup DEBT: generations whose RAG
   * delete failed when the worker cleaned a failed/lost attempt
   * (`stale_generations`, recorded token-less). Each confirmed delete pulls
   * its entry; a still-failing delete stays recorded and alerts, never lost.
   */
  const staleGenerationsCursor = makeRotatingCursor();
  const reconcileStaleGenerations = async (config) => {
    if (typeof deleteGeneration !== 'function') {
      return { scanned: 0, repaired: 0, alerted: 0 };
    }
    const assets = await listAssets(
      staleGenerationsCursor.apply({ 'stale_generations.0': { $exists: true } }),
      config.batchLimit,
      { _id: 1 },
    );
    staleGenerationsCursor.advance(assets, config.batchLimit);
    let repaired = 0;
    let alerted = 0;
    for (const asset of assets) {
      for (const generation of asset.stale_generations ?? []) {
        try {
          await deleteGeneration(asset, generation);
          await db.clearStaleGeneration({ asset_id: asset.asset_id, generation });
          repaired += 1;
        } catch (error) {
          alert(
            'cleanup_debt_unpaid',
            `generation ${asset.asset_id}:${generation} still undeletable: ${error?.message}`,
          );
          alerted += 1;
        }
      }
    }
    return { scanned: assets.length, repaired, alerted };
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
      stale_generations: (c) => reconcileStaleGenerations(c),
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

  // Scheduling deliberately lives in the worker entry point (worker.js), NOT
  // here: setInterval callbacks escape the AsyncLocalStorage context, so every
  // pass must be re-wrapped in runAsSystem for the tenant-isolated models. A
  // start()/stop() here would silently run passes without that context.
  return { runOnce };
}

module.exports = { createIndexingReconciler, getReconcilerConfig };
// End [knauf]
