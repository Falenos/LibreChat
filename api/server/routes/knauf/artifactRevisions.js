const express = require('express');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { getMessages } = require('~/models');
const {
  ArtifactEditError,
  getArtifactRevisionHistory,
  getArtifactRevisionSnapshot,
} = require('~/server/services/Artifacts/knauf/edit');

const router = express.Router();
router.use(requireJwtAuth);

const readArtifactLocator = async (req, res) => {
  const { messageId, identifier } = req.query;
  if (
    typeof messageId !== 'string' ||
    messageId.length === 0 ||
    messageId.length > 160 ||
    typeof identifier !== 'string' ||
    identifier.length === 0 ||
    identifier.length > 160 ||
    /[\r\n\0]/.test(messageId) ||
    /[\r\n\0]/.test(identifier)
  ) {
    res.status(400).json({ message: 'Invalid artifact revision.' });
    return null;
  }

  const source = await mongoose.models.Message.findOne({
    user: req.user.id,
    messageId,
  })
    .select('conversationId')
    .lean();
  if (!source) {
    res.status(404).json({ message: 'Artifact not found.' });
    return null;
  }
  return {
    messageId,
    identifier,
    messages: await getMessages({
      user: req.user.id,
      conversationId: source.conversationId,
    }),
  };
};

const handleRevisionRead = (reader) => async (req, res) => {
  try {
    const locator = await readArtifactLocator(req, res);
    if (!locator) {
      return;
    }
    return res.json(reader(locator, req));
  } catch (error) {
    const status = error instanceof ArtifactEditError ? error.status : 500;
    if (status === 500) {
      logger.error('[artifactRevisions] Failed to load revision', error);
    }
    return res.status(status).json({
      message: status === 500 ? 'Failed to load artifact revision.' : error.message,
    });
  }
};

router.get(
  '/history',
  handleRevisionRead(({ messages, messageId, identifier }) =>
    getArtifactRevisionHistory(messages, { messageId, identifier }),
  ),
);

router.get(
  '/',
  handleRevisionRead(({ messages, messageId, identifier }, req) => {
    const version = Number.parseInt(req.query.version, 10);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new ArtifactEditError('Invalid artifact revision.', 'invalid_version');
    }
    return getArtifactRevisionSnapshot(messages, {
      messageId,
      identifier,
      version,
    });
  }),
);

module.exports = router;
