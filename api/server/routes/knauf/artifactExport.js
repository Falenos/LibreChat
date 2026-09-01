const express = require('express');
const rateLimit = require('express-rate-limit');
const { logger } = require('@librechat/data-schemas');
const { getSharedMessages } = require('~/models');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const optionalJwtAuth = require('~/server/middleware/optionalJwtAuth');
const canAccessSharedLink = require('~/server/middleware/canAccessSharedLink');
const { getContentDisposition } = require('~/server/utils/files');
const {
  ArtifactExportError,
  getRenderSnapshot,
  renderArtifact,
} = require('~/server/services/Artifacts/knauf/export');

const router = express.Router();
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 'artifact_rate_limit',
    message: 'Too many artifact exports. Try again later',
  },
});

const sendExport = async (req, res) => {
  const result = await renderArtifact(req.artifact, req.body?.format);
  const title = String(req.artifact.title || 'Generated artifact').replace(/[\r\n]/g, ' ');
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Type', result.mime);
  res.set('Content-Disposition', getContentDisposition(`${title}.${result.extension}`));
  return res.status(200).send(result.buffer);
};

const handleExport = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    const status = error instanceof ArtifactExportError ? error.status : 500;
    const isSafeError = error instanceof ArtifactExportError && status < 500;
    if (status === 500) {
      logger.error('[artifactExport] Export failed', { status });
    }
    res.status(status).json({
      message: status === 500 ? 'Artifact export failed' : error.message,
      ...(isSafeError && error.code ? { code: error.code } : {}),
      ...(isSafeError && error.details ? { details: error.details } : {}),
    });
  }
};

router.get(
  '/render/:token',
  handleExport(async (req, res) => {
    const artifact = getRenderSnapshot(req.params.token, req.get('X-Knauf-Export-Secret'));
    res.set('Cache-Control', 'private, no-store');
    res.status(200).json({ artifact });
  }),
);

router.post(
  '/',
  exportLimiter,
  requireJwtAuth,
  handleExport(async (req, res) => {
    req.artifact = req.body?.artifact;
    await sendExport(req, res);
  }),
);

router.post(
  '/shared/:shareId',
  exportLimiter,
  optionalJwtAuth,
  canAccessSharedLink,
  handleExport(async (req, res) => {
    const share = await getSharedMessages(req.params.shareId, req.shareResourceId, {
      snapshotFiles: false,
    });
    if (share?.kind !== 'artifact' || !share.artifact) {
      throw new ArtifactExportError('Shared artifact not found', 404);
    }
    req.artifact = share.artifact;
    await sendExport(req, res);
  }),
);

module.exports = router;
