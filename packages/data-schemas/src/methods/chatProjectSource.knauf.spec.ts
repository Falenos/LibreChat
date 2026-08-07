// [knauf] KK20-248 — seam tests for project-scoped knowledge source DB methods.
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import type { IChatProject, IChatProjectSource } from '~/types';
import { createChatProjectMethods } from './chatProject';
import { createChatProjectSourceMethods } from './chatProjectSource';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let ChatProject: mongoose.Model<IChatProject>;
let ChatProjectSource: mongoose.Model<IChatProjectSource>;
let File: mongoose.Model<unknown>;
let modelsToCleanup: string[] = [];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  const models = createModels(mongoose);
  modelsToCleanup = Object.keys(models);
  Object.assign(mongoose.models, models);

  ChatProject = mongoose.models.ChatProject as mongoose.Model<IChatProject>;
  ChatProjectSource = mongoose.models.ChatProjectSource as mongoose.Model<IChatProjectSource>;
  File = mongoose.models.File as mongoose.Model<unknown>;

  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();

  for (const modelName of modelsToCleanup) {
    if (mongoose.models[modelName]) {
      delete mongoose.models[modelName];
    }
  }
});

afterEach(async () => {
  await ChatProject.deleteMany({});
  await ChatProjectSource.deleteMany({});
  await File.deleteMany({});
});

describe('ChatProjectSource methods', () => {
  const user = new mongoose.Types.ObjectId().toString();
  const otherUser = new mongoose.Types.ObjectId().toString();

  it('stores and updates bounded project instructions', async () => {
    const projectMethods = createChatProjectMethods(mongoose);
    const project = await projectMethods.createChatProject(user, {
      name: ' Shared knowledge ',
      instructions: ` ${'Follow project rules. '.repeat(600)} `,
    });
    const projectId = project._id!.toString();

    expect(project.instructions).toBe(`${'Follow project rules. '.repeat(600)}`.slice(0, 8000));

    const updated = await projectMethods.updateChatProject(user, projectId, {
      instructions: ' Keep answers grounded. ',
    });
    const blocked = await projectMethods.updateChatProject(otherUser, projectId, {
      instructions: 'Should not save',
    });

    expect(updated?.instructions).toBe('Keep answers grounded.');
    expect(blocked).toBeNull();
  });

  it('stores ready project file ids, includes legacy tenantless files, and keeps them isolated by project owner', async () => {
    const projectMethods = createChatProjectMethods(mongoose);
    const sourceMethods = createChatProjectSourceMethods(mongoose);
    const project = await projectMethods.createChatProject(user, {
      name: 'Shared knowledge',
      tenantId: 'tenant-1',
    });
    const projectId = project._id!.toString();

    const created = await sourceMethods.createChatProjectSource(user, {
      projectId,
      file_id: 'file-ready',
      status: 'processing',
      tenantId: 'tenant-1',
    });
    await sourceMethods.createChatProjectSource(user, {
      projectId,
      file_id: 'file-failed',
      status: 'failed',
      error: 'Parse failed',
    });
    await sourceMethods.createChatProjectSource(user, {
      projectId,
      file_id: 'file-processing',
      status: 'ready',
    });
    await sourceMethods.updateChatProjectSource(user, projectId, 'file-ready', { status: 'ready' });
    await File.create({
      user,
      tenantId: 'tenant-1',
      file_id: 'file-ready',
      filename: 'ready.md',
      filepath: '/uploads/ready.md',
      type: 'text/markdown',
      bytes: 42,
      embedded: true,
    });
    await sourceMethods.createChatProjectSource(user, {
      projectId,
      file_id: 'file-legacy',
      status: 'ready',
    });
    await File.create({
      user,
      file_id: 'file-legacy',
      filename: 'legacy.md',
      filepath: '/uploads/legacy.md',
      type: 'text/markdown',
      bytes: 42,
      embedded: true,
    });
    await File.create({
      user,
      tenantId: 'tenant-1',
      file_id: 'file-processing',
      filename: 'processing.md',
      filepath: '/uploads/processing.md',
      type: 'text/markdown',
      bytes: 42,
      embedded: false,
    });

    const readyIds = await sourceMethods.listReadyChatProjectSourceFileIds(user, projectId);
    const listedForOtherUser = await sourceMethods.listChatProjectSources(otherUser, projectId);
    const deleteByOtherUser = await sourceMethods.deleteChatProjectSource(
      otherUser,
      projectId,
      'file-ready',
    );
    await ChatProject.deleteOne({ _id: projectId, user });
    const deletedAfterProjectRemoval = await sourceMethods.deleteChatProjectSourcesForProject(
      user,
      projectId,
    );

    expect(created?.file_id).toBe('file-ready');
    expect(created?.sourceType).toBe('file');
    expect(readyIds).toEqual(expect.arrayContaining(['file-ready', 'file-legacy']));
    expect(readyIds).toHaveLength(2);
    expect(listedForOtherUser).toEqual([]);
    expect(deleteByOtherUser).toBe(false);
    expect(deletedAfterProjectRemoval).toBe(4);
  });

  it('deletes only the project file association and preserves the uploaded file row', async () => {
    const projectMethods = createChatProjectMethods(mongoose);
    const sourceMethods = createChatProjectSourceMethods(mongoose);
    const project = await projectMethods.createChatProject(user, { name: 'Delete file link' });
    const projectId = project._id!.toString();

    await sourceMethods.createChatProjectSource(user, {
      projectId,
      file_id: 'project-file',
      status: 'ready',
    });
    await File.create({
      user,
      file_id: 'project-file',
      filename: 'project-file.md',
      filepath: '/uploads/project-file.md',
      type: 'text/markdown',
      bytes: 42,
      embedded: true,
    });

    const deleted = await sourceMethods.deleteChatProjectSource(user, projectId, 'project-file');
    const sources = await sourceMethods.listChatProjectSources(user, projectId);
    const readyIds = await sourceMethods.listReadyChatProjectSourceFileIds(user, projectId);
    const fileStillExists = await File.exists({ user, file_id: 'project-file' });

    expect(deleted).toBe(true);
    expect(sources).toEqual([]);
    expect(readyIds).toEqual([]);
    expect(fileStillExists).not.toBeNull();
  });

  it('deletes project source associations across projects by file id for the same user', async () => {
    const projectMethods = createChatProjectMethods(mongoose);
    const sourceMethods = createChatProjectSourceMethods(mongoose);
    const firstProject = await projectMethods.createChatProject(user, { name: 'First' });
    const secondProject = await projectMethods.createChatProject(user, { name: 'Second' });
    const otherProject = await projectMethods.createChatProject(otherUser, { name: 'Other' });

    await sourceMethods.createChatProjectSource(user, {
      projectId: firstProject._id!.toString(),
      file_id: 'shared-file',
      status: 'ready',
    });
    await sourceMethods.createChatProjectSource(user, {
      projectId: secondProject._id!.toString(),
      file_id: 'shared-file',
      status: 'ready',
    });
    await sourceMethods.createChatProjectSource(otherUser, {
      projectId: otherProject._id!.toString(),
      file_id: 'shared-file',
      status: 'ready',
    });

    const deleted = await sourceMethods.deleteChatProjectSourcesByFileId(user, 'shared-file');

    expect(deleted).toBe(2);
    expect(await sourceMethods.listChatProjectSources(user, firstProject._id!.toString())).toEqual([]);
    expect(await sourceMethods.listChatProjectSources(user, secondProject._id!.toString())).toEqual([]);
    expect(await sourceMethods.listChatProjectSources(otherUser, otherProject._id!.toString())).toHaveLength(1);
  });
});
// End [knauf]
