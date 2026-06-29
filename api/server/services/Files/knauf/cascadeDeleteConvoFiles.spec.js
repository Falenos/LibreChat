// [knauf] KK20-203 — cascade file/embedding cleanup on chat deletion.
//
// These tests focus on the NEW logic in cascadeDeleteConvoFiles: WHICH files the
// cascade collects (union of File.conversationId / Conversation.files[] /
// Message.files[]) and WHICH it deletes vs keeps (reference-count guard). The
// actual blob/vector/Mongo/agent-ref deletion lives in processDeleteRequest
// (covered by process.integration.spec.js) and is mocked here.

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels, createMethods } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');

jest.mock('@librechat/data-schemas', () => {
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    ...actual,
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
  };
});

const mockProcessDeleteRequest = jest.fn().mockResolvedValue(undefined);
jest.mock('~/server/services/Files/process', () => ({
  processDeleteRequest: (...args) => mockProcessDeleteRequest(...args),
}));

const mockDeleteVectorsByIds = jest.fn().mockResolvedValue(undefined);
jest.mock('~/server/services/Files/VectorDB/crud', () => ({
  deleteVectorsByIds: (...args) => mockDeleteVectorsByIds(...args),
}));

jest.mock('~/models', () => {
  const m = require('mongoose');
  const { createMethods } = require('@librechat/data-schemas');
  return createMethods(m, { removeAllPermissions: jest.fn() });
});

require('module-alias/register');
const {
  collectConvoFilesForCleanup,
  cascadeDeleteCollectedFiles,
  partitionByRefCount,
} = require('./cascadeDeleteConvoFiles');

describe('cascadeDeleteConvoFiles (KK20-203)', () => {
  let mongoServer;
  let File;
  let Conversation;
  let Message;
  let Agent;
  const userId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    createModels(mongoose);
    createMethods(mongoose, { removeAllPermissions: jest.fn() });
    File = mongoose.models.File;
    Conversation = mongoose.models.Conversation;
    Message = mongoose.models.Message;
    Agent = mongoose.models.Agent;
  }, 30000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      File.deleteMany({}),
      Conversation.deleteMany({}),
      Message.deleteMany({}),
      Agent.deleteMany({}),
    ]);
    mockProcessDeleteRequest.mockClear();
    mockDeleteVectorsByIds.mockClear();
  });

  const buildReq = () => ({ user: { id: userId.toString() }, body: {}, config: {} });

  const seedFile = (file_id, extra = {}) =>
    File.create({
      file_id,
      user: userId,
      filename: `${file_id}.txt`,
      filepath: `/tmp/${file_id}`,
      object: 'file',
      type: 'text/plain',
      bytes: 1,
      source: FileSources.text,
      ...extra,
    });

  const seedConvo = (conversationId, files = []) =>
    Conversation.create({ conversationId, user: userId, title: 'Test', endpoint: 'openAI', files });

  const seedMessage = (messageId, conversationId, fileIds) =>
    Message.create({
      messageId,
      conversationId,
      user: userId,
      text: 'hi',
      files: fileIds.map((file_id) => ({ file_id })),
    });

  // Message.files[] is Mixed: legacy/imported messages can carry bare-string ids.
  const seedRawMessage = (messageId, conversationId, rawFiles) =>
    Message.create({ messageId, conversationId, user: userId, text: 'hi', files: rawFiles });

  const seedAgent = (id, toolResources, extra = {}) =>
    Agent.create({
      id,
      author: userId,
      provider: 'openAI',
      model: 'gpt-4o',
      tool_resources: toolResources,
      ...extra,
    });

  /** file_ids passed to the (single) processDeleteRequest call, sorted */
  const deletedFileIds = () =>
    (mockProcessDeleteRequest.mock.calls[0]?.[0].files ?? []).map((f) => f.file_id).sort();

  test('collects & deletes a chat-scoped file linked by File.conversationId', async () => {
    await seedConvo('convo-1');
    await seedFile('f-direct', { conversationId: 'convo-1' });

    const collected = await collectConvoFilesForCleanup({
      req: buildReq(),
      filter: { conversationId: 'convo-1' },
    });
    const result = await cascadeDeleteCollectedFiles({ req: buildReq(), collected });

    expect(mockProcessDeleteRequest).toHaveBeenCalledTimes(1);
    expect(deletedFileIds()).toEqual(['f-direct']);
    expect(result).toEqual({ deleted: 1, kept: 0 });
  });

  test('collects a message-attachment file linked only via Message.files[]', async () => {
    await seedConvo('convo-2');
    await seedFile('f-msg'); // deliberately NO conversationId on the File doc
    await seedMessage('m1', 'convo-2', ['f-msg']);

    const collected = await collectConvoFilesForCleanup({
      req: buildReq(),
      filter: { conversationId: 'convo-2' },
    });
    expect(collected.files.map((f) => f.file_id)).toContain('f-msg');

    await cascadeDeleteCollectedFiles({ req: buildReq(), collected });
    expect(deletedFileIds()).toEqual(['f-msg']);
  });

  test('keeps a file still referenced by another surviving conversation', async () => {
    await seedConvo('convo-3', ['f-shared']);
    await seedConvo('convo-keep', ['f-shared']); // survives the delete
    await seedFile('f-shared', { conversationId: 'convo-3' });

    const collected = await collectConvoFilesForCleanup({
      req: buildReq(),
      filter: { conversationId: 'convo-3' },
    });
    const result = await cascadeDeleteCollectedFiles({ req: buildReq(), collected });

    expect(mockProcessDeleteRequest).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, kept: 1 });
  });

  test('runs the retried vector backstop for embedded files', async () => {
    await seedConvo('convo-4');
    await seedFile('f-embedded', {
      conversationId: 'convo-4',
      embedded: true,
      source: FileSources.local,
    });

    const collected = await collectConvoFilesForCleanup({
      req: buildReq(),
      filter: { conversationId: 'convo-4' },
    });
    await cascadeDeleteCollectedFiles({ req: buildReq(), collected });

    expect(mockDeleteVectorsByIds).toHaveBeenCalledTimes(1);
    expect(mockDeleteVectorsByIds.mock.calls[0][1]).toEqual(['f-embedded']);
  });

  test('no-op when the conversation has no files', async () => {
    await seedConvo('convo-empty');
    const collected = await collectConvoFilesForCleanup({
      req: buildReq(),
      filter: { conversationId: 'convo-empty' },
    });
    const result = await cascadeDeleteCollectedFiles({ req: buildReq(), collected });
    expect(mockProcessDeleteRequest).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, kept: 0 });
  });

  describe('partitionByRefCount', () => {
    test('a surviving message keeps the file out of the deletable set', async () => {
      await seedFile('f-x');
      await seedMessage('m-keep', 'survivor-convo', ['f-x']);

      const { deletable, sharedStillReferenced } = await partitionByRefCount([{ file_id: 'f-x' }], {
        user: userId.toString(),
        deletedConversationIds: ['convo-deleted'],
      });

      expect(deletable).toHaveLength(0);
      expect(sharedStillReferenced.map((f) => f.file_id)).toEqual(['f-x']);
    });

    test('a file referenced only by the deleted conversations is deletable', async () => {
      await seedFile('f-y');
      await seedMessage('m-gone', 'convo-deleted', ['f-y']);

      const { deletable, sharedStillReferenced } = await partitionByRefCount([{ file_id: 'f-y' }], {
        user: userId.toString(),
        deletedConversationIds: ['convo-deleted'],
      });

      expect(sharedStillReferenced).toHaveLength(0);
      expect(deletable.map((f) => f.file_id)).toEqual(['f-y']);
    });

    // Review comment 1: a file still attached to an agent's tool_resources must
    // NOT be deletable — otherwise processDeleteRequest destroys the blob/vectors
    // and strips it from the agent, silently wiping the agent's knowledge file.
    test('an agent file_search reference keeps the file out of the deletable set', async () => {
      await seedFile('f-agent');
      await seedAgent('agent-1', { file_search: { file_ids: ['f-agent'] } });

      const { deletable, sharedStillReferenced } = await partitionByRefCount(
        [{ file_id: 'f-agent' }],
        { user: userId.toString(), deletedConversationIds: ['convo-deleted'] },
      );

      expect(deletable).toHaveLength(0);
      expect(sharedStillReferenced.map((f) => f.file_id)).toEqual(['f-agent']);
    });

    test('an agent reference via a non-file_search resource (execute_code) also protects', async () => {
      await seedFile('f-code');
      await seedAgent('agent-2', { execute_code: { file_ids: ['f-code'] } });

      const { deletable, sharedStillReferenced } = await partitionByRefCount(
        [{ file_id: 'f-code' }],
        { user: userId.toString(), deletedConversationIds: ['convo-deleted'] },
      );

      expect(deletable).toHaveLength(0);
      expect(sharedStillReferenced.map((f) => f.file_id)).toEqual(['f-code']);
    });

    test('an agent that references a DIFFERENT file does not protect the candidate', async () => {
      await seedFile('f-z');
      await seedAgent('agent-3', { file_search: { file_ids: ['some-other-file'] } });

      const { deletable, sharedStillReferenced } = await partitionByRefCount([{ file_id: 'f-z' }], {
        user: userId.toString(),
        deletedConversationIds: ['convo-deleted'],
      });

      expect(sharedStillReferenced).toHaveLength(0);
      expect(deletable.map((f) => f.file_id)).toEqual(['f-z']);
    });

    // Review comment 2: a surviving message can store bare-string file ids (legacy/
    // imported). The object-only `files.file_id` query missed them; both shapes
    // must be matched or the still-referenced file is wrongly deleted.
    test('a surviving message with a bare-string files[] entry keeps the file', async () => {
      await seedFile('f-legacy');
      await seedRawMessage('m-legacy', 'survivor-convo', ['f-legacy']);

      const { deletable, sharedStillReferenced } = await partitionByRefCount(
        [{ file_id: 'f-legacy' }],
        { user: userId.toString(), deletedConversationIds: ['convo-deleted'] },
      );

      expect(deletable).toHaveLength(0);
      expect(sharedStillReferenced.map((f) => f.file_id)).toEqual(['f-legacy']);
    });
  });

  // Review comment 1, end-to-end: a file collected from a deleted chat but still
  // attached to an agent must never reach the physical delete path.
  test('does not delete a collected file still referenced by an agent', async () => {
    await seedConvo('convo-agent');
    await seedFile('f-shared-agent', { conversationId: 'convo-agent' });
    await seedAgent('agent-keep', { file_search: { file_ids: ['f-shared-agent'] } });

    const collected = await collectConvoFilesForCleanup({
      req: buildReq(),
      filter: { conversationId: 'convo-agent' },
    });
    expect(collected.files.map((f) => f.file_id)).toContain('f-shared-agent');

    const result = await cascadeDeleteCollectedFiles({ req: buildReq(), collected });

    expect(mockProcessDeleteRequest).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, kept: 1 });
  });
});
