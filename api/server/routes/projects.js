const express = require('express');
const mongoose = require('mongoose');
const { createProjectHandlers, deleteConvoSharedLinksWithCleanup } = require('@librechat/api');
// [knauf] KK20-255 — project deletion fences and removes project-scoped schedules.
const { createSchedulerRepository } = require('@knauf/knauf/server/scheduler');
// End [knauf]
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

// [knauf] KK20-255 — scheduler documents persist authenticated users as ObjectIds.
const normalizeSchedulerUserId = (userId) =>
  mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(userId) : userId;
// End [knauf]

const prepareProjectDeleteCleanup = async (req, projectId) => {
  // [knauf] KK20-255 — prepare file cleanup before fencing scheduler writes at delete time.
  const schedulerRepository = createSchedulerRepository({
    schedules: mongoose.connection.db.collection('knauf_agent_schedules'),
    runs: mongoose.connection.db.collection('knauf_scheduled_agent_runs'),
  });
  // End [knauf]
  const collected = await collectConvoFilesForCleanup({
    req,
    filter: { chatProjectId: projectId },
  });
  const sourceRows = await db.listChatProjectSources(req.user.id, projectId);
  const candidateFileIds = [
    ...new Set(
      [
        ...(collected.files ?? []).map((file) => file.file_id),
        ...sourceRows.map((source) => source.file_id),
      ].filter(Boolean),
    ),
  ];

  const sharedProjectFileIds = candidateFileIds.length
    ? new Set(
        await (mongoose.models.ChatProjectSource || mongoose.model('ChatProjectSource')).distinct(
          'file_id',
          {
            user: req.user.id,
            sourceType: 'file',
            projectId: { $ne: projectId },
            file_id: { $in: candidateFileIds },
          },
        ),
      )
    : new Set();

  const collectedFiles = (collected.files ?? []).filter(
    (file) => !sharedProjectFileIds.has(file.file_id),
  );
  const conversationFileIds = new Set(collectedFiles.map((file) => file.file_id).filter(Boolean));
  const sourceFileIds = [
    ...new Set(sourceRows.map((source) => source.file_id).filter(Boolean)),
  ].filter((fileId) => !conversationFileIds.has(fileId) && !sharedProjectFileIds.has(fileId));
  const projectFiles = sourceFileIds.length
    ? ((await db.getFiles({ file_id: { $in: sourceFileIds }, ...projectFileOwnerFilter(req) })) ??
      [])
    : [];
  const cleanupCollected = { ...collected, files: collectedFiles };

  // [knauf] KK20-255 — fence project scheduler writes immediately before aggregate deletion.
  let schedulerFence;
  return {
    beforeDelete: async () => {
      schedulerFence = await schedulerRepository.beginProjectDeletion({
        projectId,
        user: normalizeSchedulerUserId(req.user.id),
      });
    },
    rollback: async () => {
      await schedulerRepository.cancelProjectDeletion({ fence: schedulerFence });
    },
    afterDelete: async () => {
      await schedulerRepository.deleteSchedulesForProject({ fence: schedulerFence });
      // End [knauf]
      await cascadeDeleteCollectedFiles({ req, collected: cleanupCollected });

      if (projectFiles.length) {
        await deleteFilesWithDedupAwareness({ req, files: projectFiles });
        await Promise.all(
          projectFiles.map((file) =>
            db.deleteChatProjectSourcesByFileId(req.user.id, file.file_id),
          ),
        );
      }

      await Promise.all(
        (cleanupCollected.conversationIds ?? []).map(async (conversationId) => {
          await db.deleteToolCalls(req.user.id, conversationId);
          await deleteConvoSharedLinksWithCleanup(req.user.id, conversationId);
        }),
      );
    },
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
