const express = require('express');
const { createProjectHandlers } = require('@librechat/api');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { deleteFilesWithDedupAwareness } = require('~/server/services/Files/knauf/cascadeDeleteConvoFiles');
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
  deleteChatProjectSourcesForProject: db.deleteChatProjectSourcesForProject,
  deleteChatProjectSourcesByFileId: db.deleteChatProjectSourcesByFileId,
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
router.get('/:projectId/files/:fileId/download', async (req, res) => {
  try {
    const { projectId, fileId } = req.params;
    const sources = await db.listChatProjectSources(req.user.id, projectId);
    if (!sources.some((source) => source.file_id === fileId)) {
      return res.status(404).json({ error: 'Project file not found' });
    }
    return res.redirect(
      307,
      `/api/files/download/${encodeURIComponent(req.user.id)}/${encodeURIComponent(fileId)}`,
    );
  } catch (error) {
    return res.status(500).json({ error: 'Error downloading project file' });
  }
});
router.delete('/:projectId/files/:fileId', async (req, res) => {
  try {
    const { projectId, fileId } = req.params;
    const sources = await db.listChatProjectSources(req.user.id, projectId);
    if (!sources.some((source) => source.file_id === fileId)) {
      return res.status(404).json({ error: 'Project file not found' });
    }

    const [file] = await db.getFiles({ user: req.user.id, file_id: fileId });
    const deleted = await db.deleteChatProjectSource(req.user.id, projectId, fileId);
    if (!deleted) {
      return res.status(404).json({ error: 'Project file not found' });
    }
    if (file) {
      await deleteFilesWithDedupAwareness({ req, files: [file] });
    }
    return res.status(200).json({ deleted: true });
  } catch (error) {
    return res.status(500).json({ error: 'Error deleting project file' });
  }
});
// End [knauf]
router.get('/:projectId', handlers.getProject);
router.patch('/:projectId', handlers.updateProject);
// [knauf] KK20-248 — deleting a project must remove its project knowledge files too.
router.delete('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const sources = await db.listChatProjectSources(req.user.id, projectId);
    const fileIds = sources.map((source) => source.file_id).filter(Boolean);
    const files = fileIds.length ? await db.getFiles({ user: req.user.id, file_id: { $in: fileIds } }) : [];

    const result = await db.deleteChatProject(req.user.id, projectId);
    if (!result.deletedCount) {
      return res.status(404).json({ error: 'Project not found' });
    }

    await db.deleteChatProjectSourcesForProject(req.user.id, projectId);
    if (files.length) {
      await deleteFilesWithDedupAwareness({ req, files });
    }
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: 'Error deleting project' });
  }
});
// End [knauf]

module.exports = router;
