// [knauf] KK20-248 seam test — project knowledge downloads must prove the file is
// attached to the requested project before falling through to the generic file route.
const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');

jest.mock('~/server/middleware/requireJwtAuth', () => (req, _res, next) => {
  req.user = { id: 'user-1' };
  next();
});

jest.mock('~/models', () => ({
  listChatProjects: jest.fn(),
  createChatProject: jest.fn(),
  getChatProject: jest.fn(),
  updateChatProject: jest.fn(),
  deleteChatProject: jest.fn(),
  assignConversationToProject: jest.fn(),
  createChatProjectSource: jest.fn(),
  listChatProjectSources: jest.fn(),
  deleteChatProjectSource: jest.fn(),
  deleteChatProjectSourcesByFileId: jest.fn(),
  deleteToolCalls: jest.fn(),
  getFiles: jest.fn(),
}));

const mockHandlers = {
  listProjects: jest.fn((_req, res) => res.status(200).json({ projects: [] })),
  createProject: jest.fn((_req, res) => res.status(201).json({})),
  assignConversationToProject: jest.fn((_req, res) => res.status(200).json({})),
  listProjectFiles: jest.fn((_req, res) => res.status(200).json({ files: [] })),
  addProjectFile: jest.fn((_req, res) => res.status(201).json({})),
  downloadProjectFile: jest.fn((_req, res) => res.redirect(307, '/api/files/download/user-1/file-1')),
  deleteProjectFile: jest.fn((_req, res) => res.status(200).json({ deleted: true })),
  getProject: jest.fn((_req, res) => res.status(200).json({})),
  updateProject: jest.fn((_req, res) => res.status(200).json({})),
  deleteProject: jest.fn((_req, res) => res.status(200).json({ deletedCount: 1 })),
};

const mockAttachIndexingToFiles = jest.fn(async ({ files }) => files);

jest.mock('~/server/services/Files/knauf/indexStatus', () => ({
  attachIndexingToFiles: (...args) => mockAttachIndexingToFiles(...args),
}));

jest.mock('~/server/services/Files/knauf/cascadeDeleteConvoFiles', () => ({
  collectConvoFilesForCleanup: jest.fn(),
  cascadeDeleteCollectedFiles: jest.fn(),
  deleteFilesWithDedupAwareness: jest.fn(),
}));

jest.mock(
  '@librechat/api',
  () => ({
    createProjectHandlers: jest.fn(() => mockHandlers),
    deleteConvoSharedLinksWithCleanup: jest.fn(),
  }),
  { virtual: true },
);

const db = require('~/models');
const {
  createProjectHandlers,
  deleteConvoSharedLinksWithCleanup,
} = require('@librechat/api');
const {
  collectConvoFilesForCleanup,
  cascadeDeleteCollectedFiles,
  deleteFilesWithDedupAwareness,
} = require('~/server/services/Files/knauf/cascadeDeleteConvoFiles');
const router = require('./projects');
const injectedDeps = createProjectHandlers.mock.calls[0][0];

beforeEach(() => {
  mongoose.models.ChatProjectSource = {
    distinct: jest.fn().mockResolvedValue([]),
  };
});

describe('[knauf] KK20-248 project file routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use('/api/projects', router);
  });

  it('delegates project file downloads to the project handler layer', async () => {
    const response = await request(app).get('/api/projects/project-1/files/file-1/download');

    expect(response.status).toBe(307);
    expect(response.headers.location).toBe('/api/files/download/user-1/file-1');
    expect(mockHandlers.downloadProjectFile).toHaveBeenCalled();
    expect(db.listChatProjectSources).not.toHaveBeenCalled();
  });

  it('injects the shared agent-file indexing projector', async () => {
    const files = [{ file_id: 'file-1', knauf_asset_id: 'asset-1' }];

    await expect(injectedDeps.attachIndexingToFiles(files)).resolves.toBe(files);
    expect(mockAttachIndexingToFiles).toHaveBeenCalledWith({ db, files });
  });

  it('delegates project file deletion to the project handler layer', async () => {
    const response = await request(app).delete('/api/projects/project-1/files/file-1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: true });
    expect(mockHandlers.deleteProjectFile).toHaveBeenCalled();
    expect(db.deleteChatProjectSource).not.toHaveBeenCalled();
    expect(db.getFiles).not.toHaveBeenCalled();
  });

  it('delegates project deletion to the aggregate project handler', async () => {
    const response = await request(app).delete('/api/projects/project-1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deletedCount: 1 });
    expect(mockHandlers.deleteProject).toHaveBeenCalled();
    expect(db.deleteChatProject).not.toHaveBeenCalled();
  });

  it('injects project delete cleanup that removes project files and conversation leftovers', async () => {
    collectConvoFilesForCleanup.mockResolvedValue({
      conversationIds: ['convo-1'],
      files: [{ file_id: 'shared-file' }],
    });
    db.listChatProjectSources.mockResolvedValue([
      { file_id: 'shared-file' },
      { file_id: 'project-only-file' },
    ]);
    db.getFiles.mockResolvedValue([{ file_id: 'project-only-file', filepath: '/tmp/project.pdf' }]);

    const req = { user: { id: 'user-1' } };
    const finalize = await injectedDeps.prepareProjectDeleteCleanup(req, 'project-1');
    await finalize();

    expect(collectConvoFilesForCleanup).toHaveBeenCalledWith({
      req,
      filter: { chatProjectId: 'project-1' },
    });
    expect(mongoose.models.ChatProjectSource.distinct).toHaveBeenCalledWith('file_id', {
      user: 'user-1',
      sourceType: 'file',
      projectId: { $ne: 'project-1' },
      file_id: { $in: ['shared-file', 'project-only-file'] },
    });
    expect(db.listChatProjectSources).toHaveBeenCalledWith('user-1', 'project-1');
    expect(db.getFiles).toHaveBeenCalledWith({
      file_id: { $in: ['project-only-file'] },
      user: 'user-1',
    });
    expect(cascadeDeleteCollectedFiles).toHaveBeenCalledWith({
      req,
      collected: { conversationIds: ['convo-1'], files: [{ file_id: 'shared-file' }] },
    });
    expect(deleteFilesWithDedupAwareness).toHaveBeenCalledWith({
      req,
      files: [{ file_id: 'project-only-file', filepath: '/tmp/project.pdf' }],
    });
    expect(db.deleteChatProjectSourcesByFileId).toHaveBeenCalledWith('user-1', 'project-only-file');
    expect(db.deleteToolCalls).toHaveBeenCalledWith('user-1', 'convo-1');
    expect(deleteConvoSharedLinksWithCleanup).toHaveBeenCalledWith('user-1', 'convo-1');
  });

  it('keeps files still attached to another project', async () => {
    mongoose.models.ChatProjectSource.distinct.mockResolvedValue(['shared-file', 'project-only-file']);
    collectConvoFilesForCleanup.mockResolvedValue({
      conversationIds: ['convo-1'],
      files: [{ file_id: 'shared-file' }],
    });
    db.listChatProjectSources.mockResolvedValue([
      { file_id: 'shared-file' },
      { file_id: 'project-only-file' },
    ]);

    const req = { user: { id: 'user-1' } };
    const finalize = await injectedDeps.prepareProjectDeleteCleanup(req, 'project-1');
    await finalize();

    expect(cascadeDeleteCollectedFiles).toHaveBeenCalledWith({
      req,
      collected: { conversationIds: ['convo-1'], files: [] },
    });
    expect(db.getFiles).not.toHaveBeenCalled();
    expect(deleteFilesWithDedupAwareness).not.toHaveBeenCalled();
    expect(db.deleteChatProjectSourcesByFileId).not.toHaveBeenCalled();
    expect(db.deleteToolCalls).toHaveBeenCalledWith('user-1', 'convo-1');
    expect(deleteConvoSharedLinksWithCleanup).toHaveBeenCalledWith('user-1', 'convo-1');
  });
});
// End [knauf]
