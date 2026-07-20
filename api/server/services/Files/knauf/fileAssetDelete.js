// [knauf] KK20-195 WP3d — the delete surfaces' bridge into the FileAsset
// state machine (hardened plan §8.1–§8.3). All four surfaces (direct file
// delete, conversation cascade, agent detach, retention sweep) funnel
// through two choke points — `processDeleteRequest` and `gcDedupRows` — and
// both call in here so the physical asset's deletion is RECORDED:
//
//   §8.1 last-reference rule: recount logical File rows by knauf_asset_id
//        AFTER the row delete; references remain → the asset is untouched.
//   §8.2 tombstone-before-cleanup: the deleting CAS + delete_requested_at
//        land BEFORE physical work, so a queued/processing asset can never
//        be claimed or activated mid-delete (the WP2b methods enforce it).
//   §8.3 failed cleanup → `delete_failed` with a stable code: retryable and
//        visible to operations (the WP4b reconciler picks it up). The asset
//        row is removed ONLY after cleanup reports success.
//
// Everything here is best-effort by contract: delete surfaces run inside
// response paths and sweeps that must not throw, and legacy rows that
// pre-date the FileAsset ledger simply have no asset row to record against.

/**
 * Drive one asset's §8.2 delete lifecycle around a physical-cleanup thunk:
 * tombstone (CAS → deleting) → cleanup → removeAsset on success,
 * markDeleteFailed on failure. When no asset row exists (legacy rows), the
 * cleanup still runs — there is just nothing to record.
 *
 * @param {Object} params
 * @param {Object} params.db - createMethods surface
 * @param {string} params.asset_id
 * @param {(asset?: Object) => Promise<boolean>} params.cleanup - physical GC; receives the tombstoned ledger row when present
 * @param {{ warn: Function }} params.logger
 * @returns {Promise<boolean>} whether physical cleanup reported success
 */
async function gcAssetThroughLifecycle({ db, asset_id, cleanup, logger }) {
  // KK20-195 review R4 — null and an exception are DIFFERENT outcomes:
  //   doc  → tombstoned, safe to clean.
  //   null → verify absence; a confirmed missing row is the authoritative
  //          legacy/no-ledger case → clean without recording.
  //   throw (store error, state unknown) → ABORT: cleaning here could delete
  //          blob/vectors underneath an active worker whose claim the failed
  //          tombstone never revoked. The reconciler owns the retry.
  let tombstonedAsset = null;
  try {
    tombstonedAsset = await db.tombstoneForDelete({ asset_id });
    if (!tombstonedAsset) {
      const stillThere = await db.getAssetByAssetId(asset_id);
      if (stillThere != null) {
        // Tombstone CAS returned null but the row exists — unexpected state
        // (tombstoneForDelete is idempotent); do not clean blind.
        logger?.warn(
          `[fileAssetDelete] tombstone missed but asset ${asset_id} exists (status ${stillThere.status}); aborting cleanup`,
        );
        return false;
      }
    }
  } catch (error) {
    logger?.warn(
      `[fileAssetDelete] tombstone failed for ${asset_id}; aborting cleanup (state unknown): ${error?.message}`,
    );
    return false;
  }
  const cleaned = await cleanup(tombstonedAsset);
  if (!tombstonedAsset) {
    return cleaned;
  }
  try {
    if (cleaned) {
      await db.removeAsset({ asset_id });
    } else {
      await db.markDeleteFailed({ asset_id, error_code: 'physical_cleanup_failed' });
    }
  } catch (error) {
    logger?.warn(`[fileAssetDelete] lifecycle record failed for ${asset_id}: ${error?.message}`);
  }
  return cleaned;
}

/**
 * Delete the physical state recorded by one FileAsset. The ledger, not the
 * logical File.embedded projection, is authoritative: activation may have
 * completed before the File row was finalised, and cleanup debt can contain
 * additional inactive generations.
 *
 * @param {Object} params
 * @param {import('express').Request} params.req
 * @param {Object} params.asset - tombstoned FileAsset projection
 * @param {string} params.userId - owning user for RAG auth and blob strategy
 * @param {{ deleteGeneration: Function }} params.ragClient
 * @param {(source: string) => { deleteFile: Function }} params.getStrategyFunctions
 * @param {{ warn: Function }} params.logger
 * @returns {Promise<boolean>} true only when every physical cleanup succeeded
 */
async function cleanupFileAssetPhysical({
  req,
  asset,
  userId,
  ragClient,
  getStrategyFunctions,
  logger,
}) {
  const { generationsToClean } = require('./indexingWorker');
  let cleaned = true;
  for (const generation of generationsToClean(asset)) {
    try {
      await ragClient.deleteGeneration({
        asset_id: asset.asset_id,
        generation,
        vector_backend: asset.vector_backend,
        userId,
      });
    } catch (error) {
      cleaned = false;
      logger?.warn(
        `[fileAssetDelete] vector cleanup failed for ${asset.asset_id}:${generation}: ${error?.message}`,
      );
    }
  }

  if (asset.blob?.path) {
    try {
      const { deleteFile } = getStrategyFunctions(asset.blob.source ?? 'local');
      await deleteFile(
        { ...req, user: { ...req?.user, id: userId } },
        {
          file_id: asset.asset_id,
          filepath: asset.blob.path,
          source: asset.blob.source,
          embedded: false,
        },
      );
    } catch (error) {
      cleaned = false;
      logger?.warn(
        `[fileAssetDelete] blob cleanup failed for ${asset.asset_id}: ${error?.message}`,
      );
    }
  }
  return cleaned;
}

/**
 * §8.2 tombstone-before-physical for the plain-row path (KK20-195 review R4):
 * BEFORE `processDeleteRequest` runs its physical deletes, tombstone every
 * asset whose references all sit inside the in-flight delete set — a
 * queued/processing asset can then never be claimed or activated while its
 * blob/vectors are being destroyed underneath it. Assets with surviving
 * outside references are untouched (§8.1).
 *
 * KK20-195 review F5 (re-review) — the tombstone IS the deletion fence, so a
 * store error is NOT best-effort: an asset that could not be tombstoned (or
 * whose survivor count could not be read) is still claimable/activatable, and
 * physically deleting its blob/vectors would race a worker. Such assets are
 * returned in `unfenced` so the caller SKIPS physical deletion for their files;
 * the rows stay, the reference is preserved, and the reconciler retries the
 * whole delete. Never throws.
 *
 * @param {Object} params
 * @param {Object} params.db - createMethods surface
 * @param {Array<{ file_id: string, knauf_asset_id?: string }>} params.files - the delete set
 * @param {{ warn: Function }} params.logger
 * @returns {Promise<{ unfenced: Set<string>, retained: Set<string>, tombstoned: Map<string, Object>, legacy: Set<string> }>}
 *   retained assets still have outside references; tombstoned assets own the
 *   physical cleanup; legacy ids have no ledger row and use the old path.
 */
async function preTombstoneLastReferences({ db, files, logger }) {
  const deleteIds = (files ?? []).map((f) => f?.file_id).filter(Boolean);
  const assetIds = [...new Set((files ?? []).map((f) => f?.knauf_asset_id).filter(Boolean))];
  const unfenced = new Set();
  const retained = new Set();
  const tombstoned = new Map();
  const legacy = new Set();
  for (const asset_id of assetIds) {
    try {
      const survivors =
        (await db.getFiles({ knauf_asset_id: asset_id, file_id: { $nin: deleteIds } }, null, {
          file_id: 1,
        })) ?? [];
      if (survivors.length > 0) {
        retained.add(asset_id);
        continue; // referenced outside the delete set → asset stays live
      }
      const asset = await db.tombstoneForDelete({ asset_id });
      if (asset) {
        tombstoned.set(asset_id, asset);
      } else {
        // Pre-ledger dedup rows can still carry knauf_asset_id. With no
        // FileAsset document there is no worker/activation state to fence.
        legacy.add(asset_id);
      }
    } catch (error) {
      // Fence failed / state unknown → do NOT let the caller delete underneath
      // a possibly-live asset. Mark it unfenced and skip its physical delete.
      unfenced.add(asset_id);
      logger?.warn(
        `[fileAssetDelete] pre-tombstone failed for ${asset_id}; skipping physical delete (state unknown): ${error?.message}`,
      );
    }
  }
  return { unfenced, retained, tombstoned, legacy };
}

/**
 * §8.1 for the plain-row path (`processDeleteRequest`): the upstream chain
 * already deleted blob/vectors per file and then the rows — here every
 * distinct asset the deleted rows pointed at is recounted, and assets with
 * no surviving reference are tombstoned and removed (cleanup was confirmed
 * by the upstream path before the rows were deleted; files whose storage
 * delete failed never reach the row delete, so their assets keep their
 * references untouched).
 *
 * @param {Object} params
 * @param {Object} params.db - createMethods surface (getFiles + FileAsset methods)
 * @param {Array<{ file_id: string, knauf_asset_id?: string }>} params.deletedFiles
 * @param {{ warn: Function }} params.logger
 * @returns {Promise<void>} never throws
 */
async function finalizeAssetsAfterRowDelete({ db, deletedFiles, logger }) {
  const assetIds = [...new Set((deletedFiles ?? []).map((f) => f?.knauf_asset_id).filter(Boolean))];
  for (const asset_id of assetIds) {
    try {
      const survivors =
        (await db.getFiles({ knauf_asset_id: asset_id }, null, { file_id: 1 })) ?? [];
      if (survivors.length > 0) {
        continue; // §8.1 step 4: references remain → physical state untouched.
      }
      const tombstoned = await db.tombstoneForDelete({ asset_id });
      if (!tombstoned) {
        continue; // legacy row without an asset ledger entry
      }
      await db.removeAsset({ asset_id });
    } catch (error) {
      // The WP4b reconciler owns "asset with no logical references".
      logger?.warn(`[fileAssetDelete] finalize failed for ${asset_id}: ${error?.message}`);
    }
  }
}

/**
 * A retained asset can lose its final two references concurrently: both
 * requests observe the other row, both delete only their own row, and neither
 * initially owns physical cleanup. Recount after the logical delete and only
 * tombstone the now-orphaned asset. The reconciler owns physical cleanup, so
 * concurrent recounts remain idempotent and never double-delete storage.
 *
 * @param {Object} params
 * @param {Object} params.db
 * @param {Array<{ file_id: string, knauf_asset_id?: string }>} params.deletedFiles
 * @param {Set<string>} params.retainedAssetIds
 * @param {{ warn: Function }} params.logger
 * @returns {Promise<void>} never throws
 */
async function tombstoneRetainedOrphansAfterRowDelete({
  db,
  deletedFiles,
  retainedAssetIds,
  logger,
}) {
  const candidates = [
    ...new Set(
      (deletedFiles ?? [])
        .map((file) => file?.knauf_asset_id)
        .filter((asset_id) => asset_id && retainedAssetIds?.has(asset_id)),
    ),
  ];
  for (const asset_id of candidates) {
    try {
      const survivors =
        (await db.getFiles({ knauf_asset_id: asset_id }, null, { file_id: 1 })) ?? [];
      if (survivors.length === 0) {
        await db.tombstoneForDelete({ asset_id });
      }
    } catch (error) {
      logger?.warn(
        `[fileAssetDelete] retained-orphan recount failed for ${asset_id}: ${error?.message}`,
      );
    }
  }
}

module.exports = {
  gcAssetThroughLifecycle,
  cleanupFileAssetPhysical,
  preTombstoneLastReferences,
  finalizeAssetsAfterRowDelete,
  tombstoneRetainedOrphansAfterRowDelete,
};
// End [knauf]
