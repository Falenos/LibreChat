// [knauf] KK20-248 seam test — project knowledge downloads must prove the file is
// attached to the requested project before falling through to the generic file route.
const express = require('express');
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
  deleteChatProjectSourcesForProject: jest.fn(),
  deleteChatProjectSourcesByFileId: jest.fn(),
  getFiles: jest.fn(),
}));

jest.mock(
  '@librechat/api',
  () => ({
    createProjectHandlers: jest.fn(() => ({
      listProjects: jest.fn((_req, res) => res.status(200).json({ projects: [] })),
      createProject: jest.fn((_req, res) => res.status(201).json({})),
      assignConversationToProject: jest.fn((_req, res) => res.status(200).json({})),
      listProjectFiles: jest.fn((_req, res) => res.status(200).json({ files: [] })),
      addProjectFile: jest.fn((_req, res) => res.status(201).json({})),
      deleteProjectFile: jest.fn((_req, res) => res.status(200).json({ deleted: true })),
      getProject: jest.fn((_req, res) => res.status(200).json({})),
      updateProject: jest.fn((_req, res) => res.status(200).json({})),
      deleteProject: jest.fn((_req, res) => res.status(200).json({ deletedCount: 1 })),
    })),
  }),
  { virtual: true },
);

const db = require('~/models');
const router = require('./projects');

describe('[knauf] KK20-248 project file routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use('/api/projects', router);
  });

  it('redirects only when the file is attached to the project for the user', async () => {
    db.listChatProjectSources.mockResolvedValue([{ file_id: 'file-1' }]);

    const response = await request(app).get('/api/projects/project-1/files/file-1/download');

    expect(response.status).toBe(307);
    expect(response.headers.location).toBe('/api/files/download/user-1/file-1');
    expect(db.listChatProjectSources).toHaveBeenCalledWith('user-1', 'project-1');
  });

  it('returns 404 when the file is not attached to the project', async () => {
    db.listChatProjectSources.mockResolvedValue([{ file_id: 'other-file' }]);

    const response = await request(app).get('/api/projects/project-1/files/file-1/download');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Project file not found' });
  });

  it('deletes only the project association for a project file', async () => {
    db.listChatProjectSources.mockResolvedValue([{ file_id: 'file-1' }]);
    db.deleteChatProjectSource.mockResolvedValue(true);

    const response = await request(app).delete('/api/projects/project-1/files/file-1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: true });
    expect(db.deleteChatProjectSource).toHaveBeenCalledWith('user-1', 'project-1', 'file-1');
    expect(db.getFiles).not.toHaveBeenCalled();
  });

  it('deletes the project and its source associations without deleting library files', async () => {
    db.deleteChatProject.mockResolvedValue({ deletedCount: 1, modifiedCount: 0 });
    db.deleteChatProjectSourcesForProject.mockResolvedValue(2);

    const response = await request(app).delete('/api/projects/project-1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deletedCount: 1, modifiedCount: 0 });
    expect(db.listChatProjectSources).not.toHaveBeenCalled();
    expect(db.getFiles).not.toHaveBeenCalled();
    expect(db.deleteChatProject).toHaveBeenCalledWith('user-1', 'project-1');
    expect(db.deleteChatProjectSourcesForProject).toHaveBeenCalledWith('user-1', 'project-1');
  });
});
// End [knauf]
