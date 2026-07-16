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
 * @param {() => Promise<boolean>} params.cleanup - physical GC; resolves true on confirmed cleanup
 * @param {{ warn: Function }} params.logger
 * @returns {Promise<boolean>} whether physical cleanup reported success
 */
async function gcAssetThroughLifecycle({ db, asset_id, cleanup, logger }) {
  let hasAssetRow = false;
  try {
    hasAssetRow = (await db.tombstoneForDelete({ asset_id })) != null;
  } catch (error) {
    logger?.warn(`[fileAssetDelete] tombstone failed for ${asset_id}: ${error?.message}`);
  }
  const cleaned = await cleanup();
  if (!hasAssetRow) {
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

module.exports = {
  gcAssetThroughLifecycle,
  finalizeAssetsAfterRowDelete,
};
// End [knauf]
