const express = require('express');
const { createProjectHandlers } = require('@librechat/api');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const db = require('~/models');

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
