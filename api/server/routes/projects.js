const express = require('express');
const mongoose = require('mongoose');
const { createProjectHandlers, deleteConvoSharedLinksWithCleanup } = require('@librechat/api');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const {
  collectConvoFilesForCleanup,
  cascadeDeleteCollectedFiles,
  deleteFilesWithDedupAwareness,
} = require('~/server/services/Files/knauf/cascadeDeleteConvoFiles');
// [knauf] KK20-248 — project lists share the agent file indexing projection.
const { attachIndexingToFiles } = require('~/server/services/Files/knauf/indexStatus');
// End [knauf]
const db = require('~/models');

const projectFileOwnerFilter = (req) => {
  const user = req.user?.id;
  const tenantId = req.user?.tenantId;
  if (!tenantId) {
    return { user };
  }

  return {
    user,
    $or: [{ tenantId }, { tenantId: { $exists: false } }, { tenantId: null }],
  };
};

const prepareProjectDeleteCleanup = async (req, projectId) => {
  const collected = await collectConvoFilesForCleanup({ req, filter: { chatProjectId: projectId } });
  const sourceRows = await db.listChatProjectSources(req.user.id, projectId);
  const candidateFileIds = [...new Set([
    ...(collected.files ?? []).map((file) => file.file_id),
    ...sourceRows.map((source) => source.file_id),
  ].filter(Boolean))];

  const sharedProjectFileIds = candidateFileIds.length
    ? new Set(
        await (mongoose.models.ChatProjectSource || mongoose.model('ChatProjectSource')).distinct('file_id', {
          user: req.user.id,
          sourceType: 'file',
          projectId: { $ne: projectId },
          file_id: { $in: candidateFileIds },
        }),
      )
    : new Set();

  const collectedFiles = (collected.files ?? []).filter((file) => !sharedProjectFileIds.has(file.file_id));
  const conversationFileIds = new Set(collectedFiles.map((file) => file.file_id).filter(Boolean));
  const sourceFileIds = [...new Set(sourceRows.map((source) => source.file_id).filter(Boolean))].filter(
    (fileId) => !conversationFileIds.has(fileId) && !sharedProjectFileIds.has(fileId),
  );
  const projectFiles = sourceFileIds.length
    ? ((await db.getFiles({ file_id: { $in: sourceFileIds }, ...projectFileOwnerFilter(req) })) ?? [])
    : [];
  const cleanupCollected = { ...collected, files: collectedFiles };

  return async () => {
    await cascadeDeleteCollectedFiles({ req, collected: cleanupCollected });

    if (projectFiles.length) {
      await deleteFilesWithDedupAwareness({ req, files: projectFiles });
      await Promise.all(
        projectFiles.map((file) => db.deleteChatProjectSourcesByFileId(req.user.id, file.file_id)),
      );
    }

    await Promise.all(
      (cleanupCollected.conversationIds ?? []).map(async (conversationId) => {
        await db.deleteToolCalls(req.user.id, conversationId);
        await deleteConvoSharedLinksWithCleanup(req.user.id, conversationId);
      }),
    );
  };
};

const router = express.Router();
const handlers = createProjectHandlers({
  listChatProjects: db.listChatProjects,
  createChatProject: db.createChatProject,
  getChatProject: db.getChatProject,
  updateChatProject: db.updateChatProject,
  deleteChatProject: db.deleteChatProject,
  assignConversationToProject: db.assignConversationToProject,
  // [knauf] KK20-248 — project knowledge files use explicit project-source DB methods.
  createChatProjectSource: db.createChatProjectSource,
  listChatProjectSources: db.listChatProjectSources,
  deleteChatProjectSource: db.deleteChatProjectSource,
  getFiles: db.getFiles,
  attachIndexingToFiles: (files) => attachIndexingToFiles({ db, files }),
  prepareProjectDeleteCleanup,
  // End [knauf]
});

router.use(requireJwtAuth);

router.get('/', handlers.listProjects);
router.post('/', handlers.createProject);
router.put('/conversations/:conversationId', handlers.assignConversationToProject);
// [knauf] KK20-248 — project knowledge file endpoints.
router.get('/:projectId/files', handlers.listProjectFiles);
router.post('/:projectId/files', handlers.addProjectFile);
router.get('/:projectId/files/:fileId/download', handlers.downloadProjectFile);
router.delete('/:projectId/files/:fileId', handlers.deleteProjectFile);
// End [knauf]
router.get('/:projectId', handlers.getProject);
router.patch('/:projectId', handlers.updateProject);
router.delete('/:projectId', handlers.deleteProject);

module.exports = router;
