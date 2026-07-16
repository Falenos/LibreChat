// [knauf] KK20-195 WP3c — server-side readiness enforcement for chat sends
// (hardened plan §6.5): a request that explicitly selects a file whose
// physical asset has no active generation yet (initial indexing pending or
// failed) or is delete-tombstoned is rejected with HTTP 409 and the stable
// code `file_indexing_not_ready`, BEFORE the SSE stream starts. The client
// disables send on pending files; this is the layer that holds when it
// doesn't. Files without an asset pointer (legacy rows, images, non-
// file_search resources) pass through untouched, as does any lookup failure
// — enforcement must not take chat down.

const { logger } = require('@librechat/data-schemas');
const db = require('~/models');

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const knaufFileIndexReadiness = async (req, res, next) => {
  try {
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
    // Owner-scoped: only the user's own rows can gate the user's send; the
    // client-supplied objects are never trusted for status.
    const rows =
      (await db.getFiles({ file_id: { $in: fileIds }, user: req.user.id }, null, { text: 0 })) ??
      [];
    const assetIds = [...new Set(rows.map((f) => f.knauf_asset_id).filter(Boolean))];
    if (assetIds.length === 0) {
      return next();
    }
    const assets = await db.getAssetsByAssetIds(assetIds);
    const notReady = new Set(
      assets
        .filter((a) => a.active_generation == null || a.delete_requested_at != null)
        .map((a) => a.asset_id),
    );
    if (notReady.size === 0) {
      return next();
    }
    const blockedIds = rows.filter((f) => notReady.has(f.knauf_asset_id)).map((f) => f.file_id);
    logger.info(
      `[knaufFileIndexReadiness] blocking send for user ${req.user.id}: not-ready file(s) ${blockedIds.join(', ')}`,
    );
    return res.status(409).json({ error: 'file_indexing_not_ready', file_ids: blockedIds });
  } catch (error) {
    logger.warn('[knaufFileIndexReadiness] readiness check failed; allowing request:', error);
    return next();
  }
};

module.exports = { knaufFileIndexReadiness };
// End [knauf]
