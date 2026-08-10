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

jest.mock(
  '@librechat/api',
  () => ({
    createProjectHandlers: jest.fn(() => mockHandlers),
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

  it('delegates project file downloads to the project handler layer', async () => {
    const response = await request(app).get('/api/projects/project-1/files/file-1/download');

    expect(response.status).toBe(307);
    expect(response.headers.location).toBe('/api/files/download/user-1/file-1');
    expect(mockHandlers.downloadProjectFile).toHaveBeenCalled();
    expect(db.listChatProjectSources).not.toHaveBeenCalled();
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
    expect(db.listChatProjectSources).not.toHaveBeenCalled();
    expect(db.getFiles).not.toHaveBeenCalled();
    expect(db.deleteChatProject).not.toHaveBeenCalled();
  });
});
// End [knauf]
