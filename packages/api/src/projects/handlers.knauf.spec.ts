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
    // [knauf] KK20-248 — default identity; route tests override to project shared indexing state.
    attachIndexingToFiles: jest.fn(async (files: unknown[]) => files),
    // End [knauf]
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

// [knauf] KK20-248 — project polling consumes the shared async-indexing projection.
const pendingIndexing = {
  status: 'processing',
  ready: false,
  retryable: false,
  error_code: null,
  queued_at: null,
};
// End [knauf]

describe('createProjectHandlers project files [knauf]', () => {
  it('lists only file metadata authorized for the current user and tenant', async () => {
    const deps = createDeps({
      listChatProjectSources: jest.fn(async () => [
        source('file-ready'),
        source('file-other-user'),
      ]),
      getFiles: jest.fn(async () => [
        {
          file_id: 'file-ready',
          filename: 'ready.pdf',
          type: 'application/pdf',
          bytes: 123,
          embedded: false,
          knauf_asset_id: 'asset-ready',
        },
      ]),
      // [knauf] KK20-248 — same batch enrichment used by GET /files/agent/:agent_id.
      attachIndexingToFiles: jest.fn(async (files: Array<Record<string, unknown>>) =>
        files.map((file) => ({ ...file, indexing: pendingIndexing })),
      ),
      // End [knauf]
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
      // [knauf] KK20-248 — project reads use the same indexing state as agent reads.
      { filename: 1, type: 1, bytes: 1, embedded: 1, knauf_asset_id: 1, file_id: 1 },
      // End [knauf]
    );
    expect(deps.attachIndexingToFiles).toHaveBeenCalledWith([
      expect.objectContaining({ file_id: 'file-ready', knauf_asset_id: 'asset-ready' }),
    ]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      files: [
        expect.objectContaining({
          file_id: 'file-ready',
          filename: 'ready.pdf',
          status: 'processing',
          embedded: false,
          indexing: pendingIndexing,
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
      // [knauf] KK20-248 — projection includes the asset pointer needed for shared enrichment.
      { filename: 1, type: 1, bytes: 1, embedded: 1, knauf_asset_id: 1, file_id: 1 },
      // End [knauf]
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
      // [knauf] KK20-248 — keep authorization reads aligned with project list projections.
      { filename: 1, type: 1, bytes: 1, embedded: 1, knauf_asset_id: 1, file_id: 1 },
      // End [knauf]
    );
    expect(deps.createChatProjectSource).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'File not found' });
  });

  it('attaches only an authorized current-user file', async () => {
    const deps = createDeps({
      getFiles: jest.fn(async () => [
        {
          file_id: 'owned-file',
          filename: 'owned.txt',
          type: 'text/plain',
          bytes: 10,
          embedded: true,
        },
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

    expect(deps.deleteChatProjectSource).toHaveBeenCalledWith(
      otherUserId,
      projectId,
      'foreign-file',
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Project file not found' });
  });

  it('deletes a project through the aggregate delete path only', async () => {
    const beforeDelete = jest.fn(async () => undefined);
    const afterDelete = jest.fn(async () => undefined);
    const rollback = jest.fn(async () => undefined);
    const deps = createDeps({
      deleteChatProject: jest.fn(async () => ({ deletedCount: 1, modifiedCount: 2 })),
      prepareProjectDeleteCleanup: jest.fn(async () => ({
        beforeDelete,
        afterDelete,
        rollback,
      })),
    });
    const handlers = createProjectHandlers(deps);
    const res = createResponse();

    await handlers.deleteProject({ params: { projectId }, user: { id: userId } } as any, res);

    expect(deps.prepareProjectDeleteCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ params: { projectId }, user: { id: userId } }),
      projectId,
    );
    expect(beforeDelete).toHaveBeenCalled();
    expect(deps.deleteChatProject).toHaveBeenCalledWith(userId, projectId);
    expect(afterDelete).toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ deletedCount: 1, modifiedCount: 2 });
  });

  it('does not run project cleanup finalizer when the project is not found', async () => {
    const beforeDelete = jest.fn(async () => undefined);
    const afterDelete = jest.fn(async () => undefined);
    const rollback = jest.fn(async () => undefined);
    const deps = createDeps({
      deleteChatProject: jest.fn(async () => ({ deletedCount: 0, modifiedCount: 0 })),
      prepareProjectDeleteCleanup: jest.fn(async () => ({
        beforeDelete,
        afterDelete,
        rollback,
      })),
    });
    const handlers = createProjectHandlers(deps);
    const res = createResponse();

    await handlers.deleteProject({ params: { projectId }, user: { id: userId } } as any, res);

    expect(beforeDelete).toHaveBeenCalled();
    expect(afterDelete).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Project not found' });
  });

  it('rolls back the scheduler fence when aggregate deletion fails', async () => {
    const deleteError = new Error('delete failed');
    const rollback = jest.fn(async () => undefined);
    const deps = createDeps({
      deleteChatProject: jest.fn(async () => {
        throw deleteError;
      }),
      prepareProjectDeleteCleanup: jest.fn(async () => ({
        beforeDelete: jest.fn(async () => undefined),
        afterDelete: jest.fn(),
        rollback,
      })),
    });
    const handlers = createProjectHandlers(deps);
    const res = createResponse();

    await handlers.deleteProject({ params: { projectId }, user: { id: userId } } as any, res);

    expect(rollback).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns a conflict when scheduled work is queued or actively leased', async () => {
    const conflict = Object.assign(new Error('Project has an active scheduled run'), {
      code: 'SCHEDULE_ACTIVE_RUN',
    });
    const deps = createDeps({
      prepareProjectDeleteCleanup: jest.fn(async () => ({
        beforeDelete: jest.fn(async () => {
          throw conflict;
        }),
        afterDelete: jest.fn(),
        rollback: jest.fn(),
      })),
    });
    const handlers = createProjectHandlers(deps);
    const res = createResponse();

    await handlers.deleteProject({ params: { projectId }, user: { id: userId } } as any, res);

    expect(deps.deleteChatProject).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Project has an active scheduled run',
    });
  });
});
