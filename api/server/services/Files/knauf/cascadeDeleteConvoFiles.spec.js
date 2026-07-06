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
const mockDeleteVectorsForFiles = jest.fn().mockResolvedValue(undefined);
const mockDeleteAzureSearchVectors = jest.fn().mockResolvedValue(undefined);
const mockUseAzureSearchForAgents = jest.fn().mockReturnValue(false);
jest.mock('~/server/services/Files/VectorDB/crud', () => ({
  deleteVectorsByIds: (...args) => mockDeleteVectorsByIds(...args),
  deleteVectorsForFiles: (...args) => mockDeleteVectorsForFiles(...args),
  deleteAzureSearchVectors: (...args) => mockDeleteAzureSearchVectors(...args),
  useAzureSearchForAgents: (...args) => mockUseAzureSearchForAgents(...args),
}));

// [knauf] KK20-204 — the dedup GC deletes the shared blob via the per-source strategy.
const mockStrategyDeleteFile = jest.fn().mockResolvedValue(undefined);
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({
    deleteFile: (...args) => mockStrategyDeleteFile(...args),
  })),
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
  deleteFilesWithDedupAwareness,
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
    mockDeleteVectorsForFiles.mockClear();
    mockDeleteAzureSearchVectors.mockClear();
    mockUseAzureSearchForAgents.mockClear().mockReturnValue(false);
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

    expect(mockDeleteVectorsForFiles).toHaveBeenCalledTimes(1);
    const calledFiles = mockDeleteVectorsForFiles.mock.calls[0][1];
    expect(calledFiles.map((f) => f.file_id)).toEqual(['f-embedded']);
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

  // [knauf] KK20-204 — two-stage delete for content-hash-deduped rows: delete the
  // rows always; GC the shared physical asset only when the (user, hash) group is
  // empty, always targeting the canonical file_id.
  describe('content-hash dedup delete (KK20-204)', () => {
    const db = require('~/models');
    const dedupExtra = (extra) => ({
      knauf_content_hash: 'HASH-1',
      knauf_asset_id: 'canon-1',
      embedded: true,
      source: FileSources.local,
      filepath: '/blob/canon',
      ...extra,
    });

    test('pointer chat deleted, canonical survives → physical asset kept', async () => {
      await seedFile('canon-1', dedupExtra({ conversationId: 'chatA' }));
      await seedFile('ptr-2', dedupExtra({ conversationId: 'chatB' }));
      const files = await db.getFiles({ user: userId, file_id: { $in: ['ptr-2'] } });

      const result = await cascadeDeleteCollectedFiles({
        req: buildReq(),
        collected: { conversationIds: ['chatB'], files },
      });

      expect(await File.findOne({ file_id: 'ptr-2' })).toBeNull(); // pointer row gone
      expect(await File.findOne({ file_id: 'canon-1' })).not.toBeNull(); // canonical survives
      expect(mockDeleteVectorsByIds).not.toHaveBeenCalled(); // group not empty → asset kept
      expect(mockStrategyDeleteFile).not.toHaveBeenCalled();
      expect(result.deleted).toBe(1);
    });

    test('whole group deleted → GC targets the canonical id exactly once', async () => {
      await seedFile('canon-1', dedupExtra({ conversationId: 'chatA' }));
      await seedFile('ptr-2', dedupExtra({ conversationId: 'chatB' }));
      const files = await db.getFiles({ user: userId, file_id: { $in: ['canon-1', 'ptr-2'] } });

      await cascadeDeleteCollectedFiles({
        req: buildReq(),
        collected: { conversationIds: ['chatA', 'chatB'], files },
      });

      expect(await File.countDocuments({ knauf_content_hash: 'HASH-1' })).toBe(0); // both rows gone
      expect(mockDeleteVectorsByIds).toHaveBeenCalledTimes(1);
      expect(mockDeleteVectorsByIds.mock.calls[0][1]).toEqual(['canon-1']); // canonical id, not ptr-2
      expect(mockStrategyDeleteFile).toHaveBeenCalledTimes(1);
      expect(mockStrategyDeleteFile.mock.calls[0][1].file_id).toBe('canon-1');
      expect(mockStrategyDeleteFile.mock.calls[0][1].filepath).toBe('/blob/canon');
    });

    test('last row is a pointer (canonical row already gone) → GC resolves the canonical id', async () => {
      await seedFile(
        'ptr-only',
        dedupExtra({ conversationId: 'chatB', knauf_asset_id: 'canon-gone' }),
      );
      const files = await db.getFiles({ user: userId, file_id: { $in: ['ptr-only'] } });

      await cascadeDeleteCollectedFiles({
        req: buildReq(),
        collected: { conversationIds: ['chatB'], files },
      });

      expect(await File.findOne({ file_id: 'ptr-only' })).toBeNull();
      expect(mockDeleteVectorsByIds.mock.calls[0][1]).toEqual(['canon-gone']); // from the pointer's canonical ref
      expect(mockStrategyDeleteFile.mock.calls[0][1].file_id).toBe('canon-gone');
    });

    test('legacy/no-hash file → unchanged PR1 path (processDeleteRequest, not the dedup GC)', async () => {
      await seedFile('legacy', {
        conversationId: 'chatA',
        embedded: true,
        source: FileSources.local,
      });
      const files = await db.getFiles({ user: userId, file_id: { $in: ['legacy'] } });

      await cascadeDeleteCollectedFiles({
        req: buildReq(),
        collected: { conversationIds: ['chatA'], files },
      });

      expect(mockProcessDeleteRequest).toHaveBeenCalledTimes(1);
      expect(mockProcessDeleteRequest.mock.calls[0][0].files.map((f) => f.file_id)).toEqual([
        'legacy',
      ]);
      expect(mockStrategyDeleteFile).not.toHaveBeenCalled(); // dedup GC path not taken
    });

    test('when Azure Search enabled, gcCanonicalAsset tries Azure Search before pgvector', async () => {
      mockUseAzureSearchForAgents.mockReturnValue(true);
      await seedFile('canon-az', dedupExtra({ conversationId: 'chatA' }));
      const files = await db.getFiles({ user: userId, file_id: { $in: ['canon-az'] } });

      await cascadeDeleteCollectedFiles({
        req: buildReq(),
        collected: { conversationIds: ['chatA'], files },
      });

      expect(mockDeleteAzureSearchVectors).toHaveBeenCalledTimes(1);
      expect(mockDeleteAzureSearchVectors.mock.calls[0][1]).toBe('canon-az');
      expect(mockDeleteVectorsByIds).toHaveBeenCalledTimes(1); // pgvector still called
    });
  });

  // [knauf] KK20-204 — the DIRECT file-delete path (DELETE /api/files → the files
  // route) routes owned/authorized files through deleteFilesWithDedupAwareness so a
  // deduped pointer's removal never destroys the shared asset another chat needs.
  describe('deleteFilesWithDedupAwareness (KK20-204 direct delete)', () => {
    const db = require('~/models');
    const dedupExtra = (extra) => ({
      knauf_content_hash: 'HASH-1',
      knauf_asset_id: 'canon-1',
      embedded: true,
      source: FileSources.local,
      filepath: '/blob/canon',
      ...extra,
    });

    test('deleting a pointer directly keeps the shared asset (canonical survives)', async () => {
      await seedFile('canon-1', dedupExtra({}));
      await seedFile('ptr-2', dedupExtra({}));
      const [ptr] = await db.getFiles({ user: userId, file_id: { $in: ['ptr-2'] } });

      await deleteFilesWithDedupAwareness({ req: buildReq(), files: [ptr] });

      expect(await File.findOne({ file_id: 'ptr-2' })).toBeNull(); // pointer row gone
      expect(await File.findOne({ file_id: 'canon-1' })).not.toBeNull(); // asset owner survives
      expect(mockDeleteVectorsByIds).not.toHaveBeenCalled(); // group not empty → asset kept
      expect(mockStrategyDeleteFile).not.toHaveBeenCalled();
    });

    // The exact bug this fix closes: directly deleting the canonical ROW while a
    // pointer in another chat still references the hash must NOT GC the shared asset.
    test('deleting the canonical directly while a pointer survives keeps the asset', async () => {
      await seedFile('canon-1', dedupExtra({}));
      await seedFile('ptr-2', dedupExtra({}));
      const [canon] = await db.getFiles({ user: userId, file_id: { $in: ['canon-1'] } });

      await deleteFilesWithDedupAwareness({ req: buildReq(), files: [canon] });

      expect(await File.findOne({ file_id: 'canon-1' })).toBeNull(); // canonical row gone
      expect(await File.findOne({ file_id: 'ptr-2' })).not.toBeNull(); // pointer survives
      expect(mockDeleteVectorsByIds).not.toHaveBeenCalled(); // group not empty → asset kept
      expect(mockStrategyDeleteFile).not.toHaveBeenCalled();
    });

    test('deleting the last reference GCs the shared asset exactly once', async () => {
      await seedFile('canon-1', dedupExtra({}));
      await seedFile('ptr-2', dedupExtra({}));
      const files = await db.getFiles({ user: userId, file_id: { $in: ['canon-1', 'ptr-2'] } });

      await deleteFilesWithDedupAwareness({ req: buildReq(), files });

      expect(await File.countDocuments({ knauf_content_hash: 'HASH-1' })).toBe(0);
      expect(mockDeleteVectorsByIds).toHaveBeenCalledTimes(1);
      expect(mockDeleteVectorsByIds.mock.calls[0][1]).toEqual(['canon-1']);
      expect(mockStrategyDeleteFile).toHaveBeenCalledTimes(1);
      expect(mockStrategyDeleteFile.mock.calls[0][1].file_id).toBe('canon-1');
    });

    test('a legacy/no-hash file goes through the upstream processDeleteRequest path', async () => {
      await seedFile('legacy', { embedded: true, source: FileSources.local });
      const files = await db.getFiles({ user: userId, file_id: { $in: ['legacy'] } });

      await deleteFilesWithDedupAwareness({ req: buildReq(), files });

      expect(mockProcessDeleteRequest).toHaveBeenCalledTimes(1);
      expect(mockProcessDeleteRequest.mock.calls[0][0].files.map((f) => f.file_id)).toEqual([
        'legacy',
      ]);
      expect(mockStrategyDeleteFile).not.toHaveBeenCalled(); // dedup GC not taken for plain rows
    });

    test('a mixed batch splits: plain → processDeleteRequest, deduped → group GC', async () => {
      await seedFile('legacy', { embedded: true, source: FileSources.local });
      await seedFile('canon-1', dedupExtra({}));
      const files = await db.getFiles({ user: userId, file_id: { $in: ['legacy', 'canon-1'] } });

      await deleteFilesWithDedupAwareness({ req: buildReq(), files });

      expect(mockProcessDeleteRequest.mock.calls[0][0].files.map((f) => f.file_id)).toEqual([
        'legacy',
      ]);
      // canon-1 was the last row in its group → asset GC'd via the dedup path
      expect(mockStrategyDeleteFile.mock.calls[0][1].file_id).toBe('canon-1');
    });

    // Cross-user regression: a shared-agent EDITOR (req.user = B) deletes a file
    // OWNED by author A. The group recount must be scoped to A (the owner), not B —
    // otherwise it finds none of B's rows, thinks the group is empty, and destroys
    // A's still-referenced shared asset. (Reachable via branch B / authorizedFiles.)
    test('a cross-user delete does not GC an asset the owner still references', async () => {
      const ownerId = new mongoose.Types.ObjectId(); // author A (≠ buildReq() user B)
      await seedFile('xa-owner', {
        user: ownerId,
        knauf_content_hash: 'HX',
        knauf_asset_id: 'xa-owner',
        embedded: true,
        source: FileSources.local,
        filepath: '/blob/xa',
      });
      await seedFile('xa-reuse', {
        user: ownerId,
        knauf_content_hash: 'HX',
        knauf_asset_id: 'xa-owner', // A's other chat still references the same asset
        embedded: true,
        source: FileSources.local,
        filepath: '/blob/xa',
      });
      const [ownerDoc] = await db.getFiles({ user: ownerId, file_id: { $in: ['xa-owner'] } });

      // Deleter is buildReq()'s user (B), different from ownerId (A).
      await deleteFilesWithDedupAwareness({ req: buildReq(), files: [ownerDoc] });

      expect(await File.findOne({ file_id: 'xa-owner' })).toBeNull(); // A's row deleted
      expect(await File.findOne({ file_id: 'xa-reuse' })).not.toBeNull(); // A's reuse survives
      expect(mockDeleteVectorsByIds).not.toHaveBeenCalled(); // asset KEPT (owner still references it)
      expect(mockStrategyDeleteFile).not.toHaveBeenCalled();
    });

    // Delete-last-ref vs. concurrent re-upload race: stage 1 deletes asset A's last
    // row; a concurrent re-upload MISSed and embedded a NEW asset C under the SAME
    // hash. A per-(user,hash)-group recount would see C's row, call the group
    // non-empty, and skip GC of A — orphaning A forever. The per-ASSET recount keys
    // on knauf_asset_id, so C (a different asset) doesn't mask A: A is GC'd, C is kept.
    test('GCs an orphaned asset even when a different asset survives under the same hash', async () => {
      await seedFile('asset-A', {
        knauf_content_hash: 'HH',
        knauf_asset_id: 'asset-A',
        embedded: true,
        source: FileSources.local,
        filepath: '/blob/A',
      });
      await seedFile('asset-C', {
        knauf_content_hash: 'HH', // same hash, but the concurrent re-upload's NEW owner
        knauf_asset_id: 'asset-C',
        embedded: true,
        source: FileSources.local,
        filepath: '/blob/C',
      });
      const [a] = await db.getFiles({ user: userId, file_id: { $in: ['asset-A'] } });

      await deleteFilesWithDedupAwareness({ req: buildReq(), files: [a] });

      expect(await File.findOne({ file_id: 'asset-A' })).toBeNull(); // A's row deleted
      expect(await File.findOne({ file_id: 'asset-C' })).not.toBeNull(); // C survives untouched
      expect(mockDeleteVectorsByIds).toHaveBeenCalledTimes(1);
      expect(mockDeleteVectorsByIds.mock.calls[0][1]).toEqual(['asset-A']); // A GC'd, not C
      expect(mockStrategyDeleteFile).toHaveBeenCalledTimes(1);
      expect(mockStrategyDeleteFile.mock.calls[0][1].file_id).toBe('asset-A');
      expect(mockStrategyDeleteFile.mock.calls[0][1].filepath).toBe('/blob/A');
    });

    // Double-embed: a concurrent first-upload race-loser left two distinct assets in
    // one (user, hash) group. Deleting both rows GCs EACH distinct asset independently
    // (the per-asset loop), not just the group as a whole.
    test('GCs each distinct asset when a double-embed group is fully deleted', async () => {
      await seedFile('dup-A', {
        knauf_content_hash: 'HD',
        knauf_asset_id: 'dup-A',
        embedded: true,
        source: FileSources.local,
        filepath: '/blob/dupA',
      });
      await seedFile('dup-B', {
        knauf_content_hash: 'HD',
        knauf_asset_id: 'dup-B',
        embedded: true,
        source: FileSources.local,
        filepath: '/blob/dupB',
      });
      const files = await db.getFiles({ user: userId, file_id: { $in: ['dup-A', 'dup-B'] } });

      await deleteFilesWithDedupAwareness({ req: buildReq(), files });

      expect(await File.countDocuments({ knauf_content_hash: 'HD' })).toBe(0);
      expect(mockDeleteVectorsByIds).toHaveBeenCalledTimes(2);
      const gcdVectorIds = mockDeleteVectorsByIds.mock.calls.map((c) => c[1][0]).sort();
      expect(gcdVectorIds).toEqual(['dup-A', 'dup-B']);
      const gcdBlobIds = mockStrategyDeleteFile.mock.calls.map((c) => c[1].file_id).sort();
      expect(gcdBlobIds).toEqual(['dup-A', 'dup-B']);
    });
  });
  // End [knauf]
});
