// [knauf] KK20-195 WP3c — server-side readiness enforcement for chat sends
// (hardened plan §6.5): a request that explicitly selects a file whose
// physical asset has no active generation yet (initial indexing pending or
// failed) or is delete-tombstoned is rejected with HTTP 409 and the stable
// code `file_indexing_not_ready`, BEFORE the SSE stream starts. The client
// disables send on pending files; this is the layer that holds when it
// doesn't. Files without an asset pointer (legacy rows, images, non-
// file_search resources) pass through untouched.
//
// KK20-195 review R5 — this gate FAILS CLOSED: a file carrying an asset
// pointer is usable only when a matching asset with an active generation and
// no tombstone is POSITIVELY confirmed. An asset missing from the lookup
// blocks (409 — pending/corrupt state must not produce misleading empty
// answers), and an unavailable readiness store answers 503, never next().

const { logger } = require('@librechat/data-schemas');
const db = require('~/models');

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const knaufFileIndexReadiness = async (req, res, next) => {
  const requestFiles = req.body?.files;
  if (!Array.isArray(requestFiles) || requestFiles.length === 0) {
    return next();
  }
  const fileIds = [
    ...new Set(requestFiles.map((f) => f?.file_id).filter((id) => typeof id === 'string')),
  ];
  if (fileIds.length === 0) {
    return next();
  }
  let rows;
  let readyAssetIds;
  try {
    // Owner-scoped: only the user's own rows can gate the user's send; the
    // client-supplied objects are never trusted for status.
    rows =
      (await db.getFiles({ file_id: { $in: fileIds }, user: req.user.id }, null, { text: 0 })) ??
      [];
    const assetIds = [...new Set(rows.map((f) => f.knauf_asset_id).filter(Boolean))];
    if (assetIds.length === 0) {
      return next();
    }
    const assets = await db.getAssetsByAssetIds(assetIds);
    // R5 — positive confirmation only: an asset that is absent from the
    // lookup is NOT ready (deleted/corrupt pointer), same as pending.
    readyAssetIds = new Set(
      assets
        .filter((a) => a.active_generation != null && a.delete_requested_at == null)
        .map((a) => a.asset_id),
    );
  } catch (error) {
    // R5 — the readiness store is DOWN, not the answer "ready": running chat
    // against unknown index state returns misleading empty answers. 503 so
    // the client retries, never next().
    logger.error('[knaufFileIndexReadiness] readiness store unavailable:', error);
    return res.status(503).json({ error: 'file_readiness_unavailable' });
  }
  const blockedIds = rows
    .filter((f) => f.knauf_asset_id != null && !readyAssetIds.has(f.knauf_asset_id))
    .map((f) => f.file_id);
  if (blockedIds.length === 0) {
    return next();
  }
  logger.info(
    `[knaufFileIndexReadiness] blocking send for user ${req.user.id}: not-ready file(s) ${blockedIds.join(', ')}`,
  );
  return res.status(409).json({ error: 'file_indexing_not_ready', file_ids: blockedIds });
};

module.exports = { knaufFileIndexReadiness };
// End [knauf]
