const express = require('express');
const rateLimit = require('express-rate-limit');
const { logger } = require('@librechat/data-schemas');
const { tConversationSchema } = require('librechat-data-provider');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');
const canAccessSharedLink = require('~/server/middleware/canAccessSharedLink');
const { createImportBatchBuilder } = require('~/server/utils/import/importBatchBuilder');
const { getSharedMessages } = require('~/models');

const router = express.Router();
const IDENTIFIER = 'shared-artifact';
const TYPE_LANGUAGES = {
  'application/vnd.react': 'tsx',
  'application/vnd.ant.react': 'tsx',
  'text/html': 'html',
  'application/vnd.code-html': 'html',
  'application/vnd.mermaid': 'mermaid',
  'text/markdown': 'md',
  'text/md': 'md',
};
const cloneLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many shared artifact continuations. Try again later' },
});

function safeAttribute(value, fallback) {
  return String(value || fallback)
    .replace(/["{}\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildArtifactDirective(artifact) {
  const title = safeAttribute(artifact.title, 'Generated artifact');
  const type = safeAttribute(artifact.type, 'text/plain');
  const content = String(artifact.content ?? '');
  const longestBacktickRun = (content.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    2,
  );
  const fence = '`'.repeat(longestBacktickRun + 1);
  const language = String(artifact.language || TYPE_LANGUAGES[type] || '').replace(
    /[^A-Za-z0-9_+-]/g,
    '',
  );

  return {
    text: `:::artifact{identifier="${IDENTIFIER}" type="${type}" title="${title}"}\n${fence}${language}\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}\n:::`,
    title,
    type,
  };
}

function getArtifactId({ title, type, messageId }) {
  return `${IDENTIFIER}_${type}_${title}_${messageId}`.replace(/\s+/g, '_').toLowerCase();
}

async function continueSharedArtifact(req, res) {
  const parsedConversation = tConversationSchema.safeParse(req.body?.conversation);
  if (!parsedConversation.success || !parsedConversation.data.endpoint) {
    return res.status(400).json({ message: 'A valid conversation setup is required' });
  }

  try {
    const share = await getSharedMessages(req.params.shareId, req.shareResourceId, {
      snapshotFiles: false,
    });
    if (share?.kind !== 'artifact' || !share.artifact) {
      return res.status(404).json({ message: 'Shared artifact not found' });
    }

    const setup = { ...parsedConversation.data };
    for (const field of [
      'conversationId',
      'user',
      'messages',
      'parentMessageId',
      'title',
      'createdAt',
      'updatedAt',
      'isArchived',
      'pinned',
      'tags',
      'chatProjectId',
      'file_ids',
      'resendFiles',
      'isTemporary',
      'expiredAt',
    ]) {
      delete setup[field];
    }

    const serialized = buildArtifactDirective(share.artifact);
    const builder = createImportBatchBuilder(req.user.id, req.config?.interfaceConfig);
    builder.startConversation(setup.endpoint);
    const artifactMessage = builder.addGptMessage(
      serialized.text,
      setup.model ?? undefined,
      'KARL',
    );
    const now = new Date();
    const result = builder.finishConversation(
      share.artifact.title,
      now,
      { ...setup, tags: [] },
      setup.model ?? undefined,
      now,
    );
    await builder.saveBatch();

    return res.status(201).json({
      ...result,
      artifactId: getArtifactId({ ...serialized, messageId: artifactMessage.messageId }),
    });
  } catch (_error) {
    logger.error('[artifactContinuation] Failed to clone shared artifact', { status: 500 });
    return res.status(500).json({ message: 'Shared artifact continuation failed' });
  }
}

router.post(
  '/:shareId',
  cloneLimiter,
  requireJwtAuth,
  configMiddleware,
  canAccessSharedLink,
  continueSharedArtifact,
);

module.exports = router;
module.exports.buildArtifactDirective = buildArtifactDirective;
module.exports.continueSharedArtifact = continueSharedArtifact;
