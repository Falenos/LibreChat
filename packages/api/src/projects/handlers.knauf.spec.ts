import { createProjectHandlers } from './handlers';

const userId = '64b64c7f90d3f49f3a000001';
const otherUserId = '64b64c7f90d3f49f3a000002';
const projectId = '64b64c7f90d3f49f3a000010';

const createResponse = () => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    redirect: jest.fn().mockReturnThis(),
  };
  return res as any;
};

const createDeps = (overrides: Record<string, unknown> = {}) =>
  ({
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
    prepareProjectDeleteCleanup: jest.fn(),
    ...overrides,
  }) as any;

const source = (file_id: string, status = 'processing') => ({
  projectId,
  sourceType: 'file',
  file_id,
  status,
  error: null,
});

describe('createProjectHandlers project files [knauf]', () => {
  it('lists only file metadata authorized for the current user and tenant', async () => {
    const deps = createDeps({
      listChatProjectSources: jest.fn(async () => [source('file-ready'), source('file-other-user')]),
      getFiles: jest.fn(async () => [
        {
          file_id: 'file-ready',
          filename: 'ready.pdf',
          type: 'application/pdf',
          bytes: 123,
          embedded: true,
        },
      ]),
    });
    const handlers = createProjectHandlers(deps);
    const res = createResponse();

    await handlers.listProjectFiles(
      { params: { projectId }, query: {}, user: { id: userId, tenantId: 'tenant-a' } } as any,
      res,
    );

    expect(deps.getFiles).toHaveBeenCalledWith(
      {
        file_id: { $in: ['file-ready', 'file-other-user'] },
        user: userId,
        $or: [{ tenantId: 'tenant-a' }, { tenantId: { $exists: false } }, { tenantId: null }],
      },
      {},
      { filename: 1, type: 1, bytes: 1, embedded: 1, file_id: 1 },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      files: [
        expect.objectContaining({
          file_id: 'file-ready',
          filename: 'ready.pdf',
          status: 'ready',
          embedded: true,
        }),
        expect.objectContaining({
          file_id: 'file-other-user',
          status: 'failed',
          error: 'File not found',
        }),
      ],
    });
  });

  it('lists legacy tenant-less current-user file metadata as accessible', async () => {
    const deps = createDeps({
      listChatProjectSources: jest.fn(async () => [source('legacy-file')]),
      getFiles: jest.fn(async () => [
        {
          file_id: 'legacy-file',
          filename: 'legacy.pdf',
          type: 'application/pdf',
          bytes: 321,
          embedded: true,
        },
      ]),
    });
    const handlers = createProjectHandlers(deps);
    const res = createResponse();

    await handlers.listProjectFiles(
      { params: { projectId }, query: {}, user: { id: userId, tenantId: 'tenant-a' } } as any,
      res,
    );

    expect(deps.getFiles).toHaveBeenCalledWith(
      {
        file_id: { $in: ['legacy-file'] },
        user: userId,
        $or: [{ tenantId: 'tenant-a' }, { tenantId: { $exists: false } }, { tenantId: null }],
      },
      {},
      { filename: 1, type: 1, bytes: 1, embedded: 1, file_id: 1 },
    );
    expect(res.json).toHaveBeenCalledWith({
      files: [
        expect.objectContaining({
          file_id: 'legacy-file',
          filename: 'legacy.pdf',
          status: 'ready',
        }),
      ],
    });
  });

  it('rejects attaching a file not owned by the current user', async () => {
    const deps = createDeps({
      getFiles: jest.fn(async () => []),
      createChatProjectSource: jest.fn(),
    });
    const handlers = createProjectHandlers(deps);
    const res = createResponse();

    await handlers.addProjectFile(
      { params: { projectId }, body: { file_id: 'foreign-file' }, user: { id: userId } } as any,
      res,
    );

    expect(deps.getFiles).toHaveBeenCalledWith(
      { file_id: { $in: ['foreign-file'] }, user: userId },
      {},
      { filename: 1, type: 1, bytes: 1, embedded: 1, file_id: 1 },
    );
    expect(deps.createChatProjectSource).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'File not found' });
  });

  it('attaches only an authorized current-user file', async () => {
    const deps = createDeps({
      getFiles: jest.fn(async () => [
        { file_id: 'owned-file', filename: 'owned.txt', type: 'text/plain', bytes: 10, embedded: true },
      ]),
      createChatProjectSource: jest.fn(async () => source('owned-file')),
    });
    const handlers = createProjectHandlers(deps);
    const res = createResponse();

    await handlers.addProjectFile(
      { params: { projectId }, body: { file_id: 'owned-file' }, user: { id: userId } } as any,
      res,
    );

    expect(deps.createChatProjectSource).toHaveBeenCalledWith(userId, {
      projectId,
      file_id: 'owned-file',
      status: undefined,
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ file_id: 'owned-file', filename: 'owned.txt', status: 'ready' }),
    );
  });

  it('redirects project file download only after verifying project attachment', async () => {
    const deps = createDeps({
      listChatProjectSources: jest.fn(async () => [source('file-1')]),
    });
    const handlers = createProjectHandlers(deps);
    const res = createResponse();

    await handlers.downloadProjectFile(
      { params: { projectId, fileId: 'file-1' }, user: { id: userId } } as any,
      res,
    );

    expect(deps.listChatProjectSources).toHaveBeenCalledWith(userId, projectId);
    expect(res.redirect).toHaveBeenCalledWith(307, `/api/files/download/${userId}/file-1`);
  });

  it('rejects project file download when the file is not attached to the project', async () => {
    const deps = createDeps({
      listChatProjectSources: jest.fn(async () => [source('other-file')]),
    });
    const handlers = createProjectHandlers(deps);
    const res = createResponse();

    await handlers.downloadProjectFile(
      { params: { projectId, fileId: 'file-1' }, user: { id: userId } } as any,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Project file not found' });
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('does not delete another user project file association', async () => {
    const deps = createDeps({ deleteChatProjectSource: jest.fn(async () => false) });
    const handlers = createProjectHandlers(deps);
    const res = createResponse();

    await handlers.deleteProjectFile(
      { params: { projectId, fileId: 'foreign-file' }, user: { id: otherUserId } } as any,
      res,
    );

    expect(deps.deleteChatProjectSource).toHaveBeenCalledWith(otherUserId, projectId, 'foreign-file');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Project file not found' });
  });

  it('deletes a project through the aggregate delete path only', async () => {
    const finalizeCleanup = jest.fn(async () => undefined);
    const deps = createDeps({
      deleteChatProject: jest.fn(async () => ({ deletedCount: 1, modifiedCount: 2 })),
      prepareProjectDeleteCleanup: jest.fn(async () => finalizeCleanup),
    });
    const handlers = createProjectHandlers(deps);
    const res = createResponse();

    await handlers.deleteProject(
      { params: { projectId }, user: { id: userId } } as any,
      res,
    );

    expect(deps.prepareProjectDeleteCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ params: { projectId }, user: { id: userId } }),
      projectId,
    );
    expect(deps.deleteChatProject).toHaveBeenCalledWith(userId, projectId);
    expect(finalizeCleanup).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ deletedCount: 1, modifiedCount: 2 });
  });

  it('does not run project cleanup finalizer when the project is not found', async () => {
    const finalizeCleanup = jest.fn(async () => undefined);
    const deps = createDeps({
      deleteChatProject: jest.fn(async () => ({ deletedCount: 0, modifiedCount: 0 })),
      prepareProjectDeleteCleanup: jest.fn(async () => finalizeCleanup),
    });
    const handlers = createProjectHandlers(deps);
    const res = createResponse();

    await handlers.deleteProject(
      { params: { projectId }, user: { id: userId } } as any,
      res,
    );

    expect(finalizeCleanup).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Project not found' });
  });
});
