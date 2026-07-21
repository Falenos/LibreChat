// [knauf] KK20-195 WP3c — read-side status projections + the retry decision
// for the async file-indexing lifecycle (hardened plan §6.3/§6.4). DI-style
// (the caller passes `db`, the createMethods surface) so everything
// unit-tests against a real Mongo without mocking the world.
//
// One rule everywhere: a logical File row WITHOUT a `knauf_asset_id` (or
// whose asset document is missing — pre-migration legacy rows) projects from
// its own `embedded` flag, defaulting to ready. Rows WITH an asset project
// through `buildIndexingProjection` (ready = active generation exists and no
// delete tombstone — a replacement re-index keeps `ready=true`).

const { logger } = require('@librechat/data-schemas');
const { buildIndexingProjection } = require('./fileSearchAssetLifecycle');
const { isIndexingWorkerEnabled } = require('./asyncIndexingConfig');

/** The §6.3 batch counters. Anything unknown lands in `processing`. */
const BATCH_STATUSES = ['uploading', 'queued', 'processing', 'ready', 'failed'];

/**
 * Projection for one logical file (plan §6.2 shape, same as the upload
 * response's `indexing` sibling).
 * @param {{ knauf_asset_id?: string, embedded?: boolean } | null | undefined} file
 * @param {Object | null | undefined} asset - the FileAsset row, when already loaded
 * @returns {{ status: string, ready: boolean, retryable: boolean, error_code: string | null, queued_at: Date | null }}
 */
function projectFileIndexing(file, asset) {
  if (asset) {
    return buildIndexingProjection(asset);
  }
  if (file?.knauf_asset_id && file?.embedded === false) {
    // Asset pointer exists but the asset row is gone (removed reservation /
    // interrupted migration) and the file never embedded: surface as failed
    // so the client offers retry-or-delete instead of spinning forever.
    return {
      status: 'failed',
      ready: false,
      retryable: false,
      error_code: 'asset_missing',
      queued_at: null,
    };
  }
  // Legacy / non-file_search rows: absent state means ready (back-compat).
  return buildIndexingProjection(null);
}

/**
 * Batch-load the assets for a set of File rows and attach the `indexing`
 * projection to every row that carries an asset pointer (list APIs — one
 * query for the whole page instead of one request per row, plan §6.3).
 * Rows without `knauf_asset_id` are passed through untouched so non-Knauf
 * consumers of the list payload see exactly the upstream shape.
 *
 * @param {Object} params
 * @param {Object} params.db - createMethods surface (getAssetsByAssetIds)
 * @param {Array<Object>} params.files - lean File rows
 * @returns {Promise<Array<Object>>}
 */
async function attachIndexingCore({ db, files }) {
  const assetIds = [...new Set(files.map((f) => f?.knauf_asset_id).filter(Boolean))];
  if (assetIds.length === 0) {
    return files;
  }
  const assets = await db.getAssetsByAssetIds(assetIds);
  const byId = new Map(assets.map((a) => [a.asset_id, a]));
  return files.map((file) => {
    if (!file?.knauf_asset_id) {
      return file;
    }
    const raw = typeof file.toObject === 'function' ? file.toObject() : file;
    return { ...raw, indexing: projectFileIndexing(file, byId.get(file.knauf_asset_id)) };
  });
}

async function attachIndexingToFiles({ db, files }) {
  if (!Array.isArray(files) || files.length === 0) {
    return files ?? [];
  }
  try {
    return await attachIndexingCore({ db, files });
  } catch (error) {
    // Attaching the indexing projection is enrichment, not core: a transient
    // asset-collection failure (or a stale dist missing getAssetsByAssetIds)
    // must not take the whole file LISTING down. Degrade to the upstream rows.
    // NOTE: batch-status uses attachIndexingCore directly — it must NOT swallow
    // here, or a degraded page projects every row to ready/failed and reports a
    // FALSE `terminal: true`, stopping the client's progress poll mid-flight.
    logger.warn(
      `[attachIndexingToFiles] indexing projection failed; returning plain rows: ${error?.message}`,
    );
    return files;
  }
}

/**
 * The §6.3 batch projection: one owner-scoped query over logical File rows
 * (the client-generated batch id is NEVER authorization), one asset batch
 * load, one derived summary. Counts are logical rows, not deduped assets;
 * `terminal` only when every accepted row is ready or failed. Uploads whose
 * durable rows don't exist yet are invisible here by design — the client
 * keeps its own selected-file count while requests are in flight.
 *
 * @param {Object} params
 * @param {Object} params.db - createMethods surface (getFiles, getAssetsByAssetIds)
 * @param {string} params.userId
 * @param {string} params.batchId
 * @returns {Promise<Object>}
 */
async function buildBatchIndexStatus({ db, userId, batchId }) {
  const files =
    (await db.getFiles({ user: userId, knauf_upload_batch_id: batchId }, null, { text: 0 })) ?? [];
  // Strict (non-swallowing): a projection failure must propagate so the route
  // returns 500 and the client retries the tick — never a false `terminal`.
  const withIndexing = await attachIndexingCore({ db, files });

  const counts = Object.fromEntries(BATCH_STATUSES.map((s) => [s, 0]));
  const failures = [];
  for (const file of withIndexing) {
    const indexing = file.indexing ?? projectFileIndexing(file, null);
    const bucket = BATCH_STATUSES.includes(indexing.status) ? indexing.status : 'processing';
    counts[bucket] += 1;
    if (indexing.status === 'failed') {
      failures.push({
        file_id: file.file_id,
        error_code: indexing.error_code,
        retryable: indexing.retryable,
      });
    }
  }
  return {
    batch_id: batchId,
    total: withIndexing.length,
    terminal: withIndexing.length > 0 && counts.ready + counts.failed === withIndexing.length,
    counts,
    failures,
  };
}

/**
 * The §6.4 retry decision for one (already authorized) logical file.
 * CASes only failed → queued; idempotent when another reference already
 * retried the shared asset; requires confirmed blob metadata (otherwise the
 * bytes are gone and only a re-upload can help); never touches ready /
 * deleting / delete_failed assets.
 *
 * @param {Object} params
 * @param {Object} params.db - createMethods surface
 * @param {{ file_id: string, knauf_asset_id?: string }} params.file
 * @returns {Promise<{ httpStatus: number, body: Object }>}
 */
async function retryFileIndexing({ db, file }) {
  const asset_id = file?.knauf_asset_id;
  const asset = asset_id ? await db.getAssetByAssetId(asset_id) : null;
  if (!asset) {
    return {
      httpStatus: 409,
      body: { error: 'file_reupload_required', file_id: file.file_id },
    };
  }
  if (asset.delete_requested_at != null || ['deleting', 'delete_failed'].includes(asset.status)) {
    return {
      httpStatus: 409,
      body: { error: 'file_asset_deleting', file_id: file.file_id },
    };
  }
  if (asset.status === 'failed') {
    if (!asset.blob?.path) {
      // The failure happened before durable blob metadata was recorded —
      // there is nothing for the worker to re-read.
      return {
        httpStatus: 409,
        body: { error: 'file_reupload_required', file_id: file.file_id },
      };
    }
    if (!isIndexingWorkerEnabled()) {
      // KK20-195 review — with the worker disabled nothing will ever claim a
      // queued asset. Requeuing here would strand it in a non-terminal state
      // that polls and gates chat send forever. Keep it 'failed' (terminal, so
      // the client stops polling and shows the failure); recovery is
      // delete + re-upload until WP6 enables the worker.
      return {
        httpStatus: 409,
        body: { error: 'indexing_worker_unavailable', file_id: file.file_id },
      };
    }
    const retried = await db.retryFailed({ asset_id });
    if (retried) {
      return {
        httpStatus: 202,
        body: { file_id: file.file_id, indexing: buildIndexingProjection(retried) },
      };
    }
    // Lost the CAS: someone else transitioned the asset first — fall through
    // to an idempotent read of whatever state won.
  }
  const live = (await db.getAssetByAssetId(asset_id)) ?? asset;
  const indexing = buildIndexingProjection(live);
  return {
    // ready → 200 (nothing to retry); in-flight → 202 (join the existing work).
    httpStatus: indexing.ready && live.status === 'ready' ? 200 : 202,
    body: { file_id: file.file_id, indexing },
  };
}

module.exports = {
  projectFileIndexing,
  attachIndexingCore,
  attachIndexingToFiles,
  buildBatchIndexStatus,
  retryFileIndexing,
};
// End [knauf]
