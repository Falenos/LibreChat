// [knauf] KK20-195 review R6 — authorization for the MUTATING retry endpoint
// (PR #143 finding 11): `fileAccess` grants access through an agent when the
// caller merely has VIEW, but POST /files/:file_id/index/retry requeues a
// shared physical asset and consumes OCR/embedding capacity. VIEW keeps the
// read-only status endpoints; retry requires FILE OWNERSHIP or EDIT on an
// agent that carries the file (mirrors accessResources/fileAccess.js
// `checkAgentBasedFileAccess`, with PermissionBits.EDIT). Runs AFTER
// `fileAccess` (req.fileAccess.file is already loaded + VIEW-authorized).
// Fails closed: any check error is a 403, never a pass-through.

const { PermissionBits, hasPermissions, ResourceType } = require('librechat-data-provider');
const { getEffectivePermissions } = require('~/server/services/PermissionService');
const { logger } = require('@librechat/data-schemas');
const { getAgents } = require('~/models');

const FILE_RESOURCE_PATHS = [
  'tool_resources.execute_code.file_ids',
  'tool_resources.file_search.file_ids',
  'tool_resources.image_edit.file_ids',
  'tool_resources.context.file_ids',
  'tool_resources.ocr.file_ids',
];

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const knaufFileIndexRetryAuth = async (req, res, next) => {
  try {
    const file = req.fileAccess?.file;
    if (file == null) {
      return res.status(403).json({ error: 'file_index_retry_forbidden' });
    }
    if (String(file.user) === String(req.user.id)) {
      return next(); // the owner may always retry their own file
    }
    const agentsWithFile = await getAgents({
      $or: FILE_RESOURCE_PATHS.map((path) => ({ [path]: file.file_id })),
    });
    for (const agent of agentsWithFile ?? []) {
      const permissions = await getEffectivePermissions({
        userId: req.user.id,
        role: req.user.role,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id ?? agent.id,
      });
      if (hasPermissions(permissions, PermissionBits.EDIT)) {
        return next(); // may edit an agent carrying the file → may re-index it
      }
    }
    logger.info(
      `[knaufFileIndexRetryAuth] user ${req.user.id} denied retry on ${file.file_id} (VIEW-only access)`,
    );
    return res.status(403).json({ error: 'file_index_retry_forbidden' });
  } catch (error) {
    logger.warn('[knaufFileIndexRetryAuth] authorization check failed; denying:', error);
    return res.status(403).json({ error: 'file_index_retry_forbidden' });
  }
};

module.exports = { knaufFileIndexRetryAuth };
// End [knauf]
