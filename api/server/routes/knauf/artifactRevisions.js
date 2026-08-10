const express = require('express');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { getMessages } = require('~/models');
const {
  ArtifactEditError,
  getArtifactRevisionSnapshot,
} = require('~/server/services/Artifacts/knauf/edit');

const router = express.Router();
router.use(requireJwtAuth);

router.get('/', async (req, res) => {
  const { messageId, identifier } = req.query;
  const version = Number.parseInt(req.query.version, 10);
  if (
    typeof messageId !== 'string' ||
    messageId.length === 0 ||
    messageId.length > 160 ||
    typeof identifier !== 'string' ||
    identifier.length === 0 ||
    identifier.length > 160 ||
    /[\r\n\0]/.test(messageId) ||
    /[\r\n\0]/.test(identifier) ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    return res.status(400).json({ message: 'Invalid artifact revision.' });
  }

  try {
    const source = await mongoose.models.Message.findOne({
      user: req.user.id,
      messageId,
    })
      .select('conversationId')
      .lean();
    if (!source) {
      return res.status(404).json({ message: 'Artifact not found.' });
    }
    const messages = await getMessages({
      user: req.user.id,
      conversationId: source.conversationId,
    });
    return res.json(
      getArtifactRevisionSnapshot(messages, {
        messageId,
        identifier,
        version,
      }),
    );
  } catch (error) {
    const status = error instanceof ArtifactEditError ? error.status : 500;
    if (status === 500) {
      logger.error('[artifactRevisions] Failed to load revision', error);
    }
    return res.status(status).json({
      message: status === 500 ? 'Failed to load artifact revision.' : error.message,
    });
  }
});

module.exports = router;
