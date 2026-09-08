import mongoose from 'mongoose';
import { EModelEndpoint } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoMeili, { type SchemaWithMeiliMethods } from '~/models/plugins/mongoMeili';
import { createConversationModel } from '~/models/convo';
import { createMessageModel } from '~/models/message';

interface DynamicMeiliDocument extends mongoose.Document {
  docId: string;
  user: string;
  title: string;
  isTemporary?: boolean;
  expiredAt?: Date | null;
  _meiliIndex?: boolean;
}

type DynamicMeiliModel = mongoose.Model<DynamicMeiliDocument> & SchemaWithMeiliMethods;

// [knauf] Let reconciliation tests configure batch sizing and retry pacing.
const createDynamicMeiliModel = (
  modelName: string,
  syncOptions: { syncBatchSize?: number; syncDelayMs?: number } = {},
): DynamicMeiliModel => {
  // End [knauf]
  const schema = new mongoose.Schema<DynamicMeiliDocument>({
    docId: {
      type: String,
      required: true,
      meiliIndex: true,
    },
    title: {
      type: String,
      meiliIndex: true,
    },
    user: {
      type: String,
      meiliIndex: true,
    },
    isTemporary: {
      type: Boolean,
      default: false,
    },
    expiredAt: {
      type: Date,
    },
  });

  schema.plugin(mongoMeili, {
    mongoose,
    host: 'foo',
    apiKey: 'bar',
    indexName: modelName.toLowerCase(),
    primaryKey: 'docId',
    // [knauf] Exercise the production retry budget with deterministic test limits.
    ...syncOptions,
    // End [knauf]
  });

  return mongoose.model<DynamicMeiliDocument>(modelName, schema) as unknown as DynamicMeiliModel;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const mockAddDocuments = jest.fn();
const mockAddDocumentsInBatches = jest.fn();
const mockUpdateDocuments = jest.fn();
const mockDeleteDocument = jest.fn();
const mockDeleteDocuments = jest.fn();
const mockGetDocument = jest.fn();
// [knauf] Model terminal Meilisearch task completion for bulk-sync fencing tests.
const mockWaitForTask = jest.fn();
// End [knauf]
const mockIndex = jest.fn().mockReturnValue({
  getRawInfo: jest.fn(),
  updateSettings: jest.fn(),
  addDocuments: mockAddDocuments,
  addDocumentsInBatches: mockAddDocumentsInBatches,
  updateDocuments: mockUpdateDocuments,
  deleteDocument: mockDeleteDocument,
  deleteDocuments: mockDeleteDocuments,
  getDocument: mockGetDocument,
  getDocuments: jest.fn().mockReturnValue({ results: [] }),
  // [knauf] Expose task polling on the mocked index.
  waitForTask: mockWaitForTask,
  // End [knauf]
});
jest.mock('meilisearch', () => {
  return {
    // [knauf] Preserve instanceof checks used by the task polling loop.
    MeiliSearchTimeOutError: class MeiliSearchTimeOutError extends Error {},
    // End [knauf]
    MeiliSearch: jest.fn().mockImplementation(() => {
      return {
        index: mockIndex,
      };
    }),
  };
});

describe('Meilisearch Mongoose plugin', () => {
  const OLD_ENV = process.env;

  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    process.env = {
      ...OLD_ENV,
      // Set a fake meilisearch host/key so that we activate the meilisearch plugin
      MEILI_HOST: 'foo',
      MEILI_MASTER_KEY: 'bar',
    };

    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
  });

  beforeEach(() => {
    // [knauf] Every Meilisearch write returns one queued task that succeeds by default.
    mockAddDocuments.mockReset().mockResolvedValue({ taskUid: 1 });
    mockAddDocumentsInBatches.mockReset().mockResolvedValue([{ taskUid: 1 }]);
    // End [knauf]
    mockUpdateDocuments.mockClear();
    mockDeleteDocument.mockClear();
    // [knauf] Cleanup mutations return queued task identifiers.
    mockDeleteDocuments.mockReset().mockResolvedValue({ taskUid: 2 });
    // End [knauf]
    mockGetDocument.mockClear();
    // [knauf] Reset terminal task behavior between bulk-sync tests.
    mockWaitForTask.mockReset().mockResolvedValue({ status: 'succeeded' });
    // End [knauf]
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();

    process.env = OLD_ENV;
  });

  test('saving conversation indexes w/ meilisearch', async () => {
    await createConversationModel(mongoose).create({
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      title: 'Test Conversation',
      endpoint: EModelEndpoint.openAI,
    });
    expect(mockAddDocuments).toHaveBeenCalledWith(
      [expect.objectContaining({ conversationId: expect.anything() })],
      { primaryKey: 'conversationId' },
    );
  });

  test('saving conversation indexes with expiredAt=null w/ meilisearch', async () => {
    await createConversationModel(mongoose).create({
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      title: 'Test Conversation',
      endpoint: EModelEndpoint.openAI,
      expiredAt: null,
    });
    expect(mockAddDocuments).toHaveBeenCalled();
  });

  test('saving retained non-temporary conversation indexes w/ meilisearch', async () => {
    await createConversationModel(mongoose).create({
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      title: 'Test Conversation',
      endpoint: EModelEndpoint.openAI,
      isTemporary: false,
      expiredAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(mockAddDocuments).toHaveBeenCalled();
  });

  test('saving expired retained non-temporary conversation does NOT index w/ meilisearch', async () => {
    await createConversationModel(mongoose).create({
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      title: 'Test Conversation',
      endpoint: EModelEndpoint.openAI,
      isTemporary: false,
      expiredAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect(mockAddDocuments).not.toHaveBeenCalled();
  });

  test('saving temporary conversation does NOT index w/ meilisearch', async () => {
    await createConversationModel(mongoose).create({
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      title: 'Test Conversation',
      endpoint: EModelEndpoint.openAI,
      isTemporary: true,
      expiredAt: new Date(),
    });
    expect(mockAddDocuments).not.toHaveBeenCalled();
  });

  test('saving messages indexes w/ meilisearch', async () => {
    await createMessageModel(mongoose).create({
      messageId: new mongoose.Types.ObjectId(),
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      isCreatedByUser: true,
    });
    expect(mockAddDocuments).toHaveBeenCalledWith(
      [expect.objectContaining({ messageId: expect.anything() })],
      { primaryKey: 'messageId' },
    );
  });

  test('saving messages with expiredAt=null indexes w/ meilisearch', async () => {
    await createMessageModel(mongoose).create({
      messageId: new mongoose.Types.ObjectId(),
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      isCreatedByUser: true,
      expiredAt: null,
    });
    expect(mockAddDocuments).toHaveBeenCalled();
  });

  test('saving retained non-temporary messages indexes w/ meilisearch', async () => {
    await createMessageModel(mongoose).create({
      messageId: new mongoose.Types.ObjectId(),
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      isCreatedByUser: true,
      isTemporary: false,
      expiredAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(mockAddDocuments).toHaveBeenCalled();
  });

  test('saving expired retained non-temporary message does NOT index w/ meilisearch', async () => {
    await createMessageModel(mongoose).create({
      messageId: new mongoose.Types.ObjectId(),
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      isCreatedByUser: true,
      isTemporary: false,
      expiredAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect(mockAddDocuments).not.toHaveBeenCalled();
  });

  test('saving temporary messages does NOT index w/ meilisearch', async () => {
    await createMessageModel(mongoose).create({
      messageId: new mongoose.Types.ObjectId(),
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      isCreatedByUser: true,
      isTemporary: true,
      expiredAt: new Date(),
    });
    expect(mockAddDocuments).not.toHaveBeenCalled();
  });

  test('updating an indexed conversation calls updateDocuments with primaryKey', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    const convo = await conversationModel.create({
      conversationId: new mongoose.Types.ObjectId().toString(),
      user: new mongoose.Types.ObjectId(),
      title: 'Original Title',
      endpoint: EModelEndpoint.openAI,
    });
    mockUpdateDocuments.mockClear();

    convo._meiliIndex = true;
    convo.title = 'Updated Title';
    await convo.save();

    expect(mockUpdateDocuments).toHaveBeenCalledWith(
      [expect.objectContaining({ conversationId: expect.anything() })],
      { primaryKey: 'conversationId' },
    );
  });

  test('updating an indexed message calls updateDocuments with primaryKey: messageId', async () => {
    const messageModel = createMessageModel(mongoose);
    const msg = await messageModel.create({
      messageId: new mongoose.Types.ObjectId().toString(),
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      isCreatedByUser: true,
    });
    mockUpdateDocuments.mockClear();

    msg._meiliIndex = true;
    msg.text = 'Updated text';
    await msg.save();

    expect(mockUpdateDocuments).toHaveBeenCalledWith(
      [expect.objectContaining({ messageId: expect.anything() })],
      { primaryKey: 'messageId' },
    );
  });

  test('deleteObjectFromMeili calls deleteDocument with messageId, not _id', async () => {
    const messageModel = createMessageModel(mongoose);
    const msgId = new mongoose.Types.ObjectId().toString();
    const msg = await messageModel.create({
      messageId: msgId,
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      isCreatedByUser: true,
    });
    mockDeleteDocument.mockClear();

    const typedMsg = msg as unknown as import('./mongoMeili').DocumentWithMeiliIndex;
    await new Promise<void>((resolve, reject) => {
      typedMsg.deleteObjectFromMeili!((err) => (err ? reject(err) : resolve()));
    });

    expect(mockDeleteDocument).toHaveBeenCalledWith(msgId);
    expect(mockDeleteDocument).not.toHaveBeenCalledWith(String(msg._id));
  });

  test('updateDocuments receives preprocessed data with primaryKey', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    const conversationId = 'abc|def|ghi';
    const convo = await conversationModel.create({
      conversationId,
      user: new mongoose.Types.ObjectId(),
      title: 'Pipe Test',
      endpoint: EModelEndpoint.openAI,
    });
    mockUpdateDocuments.mockClear();

    convo._meiliIndex = true;
    convo.title = 'Updated Pipe Test';
    await convo.save();

    expect(mockUpdateDocuments).toHaveBeenCalledWith(
      [expect.objectContaining({ conversationId: 'abc--def--ghi' })],
      { primaryKey: 'conversationId' },
    );
  });

  test('sync w/ meili does not include TTL documents', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    await conversationModel.create({
      conversationId: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      title: 'Test Conversation',
      endpoint: EModelEndpoint.openAI,
      isTemporary: true,
      expiredAt: new Date(),
    });

    await conversationModel.syncWithMeili();

    expect(mockAddDocuments).not.toHaveBeenCalled();
  });

  test('sync w/ meili excludes legacy temporary conversations without isTemporary', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    await conversationModel.deleteMany({});
    mockAddDocuments.mockClear();
    const conversationId = new mongoose.Types.ObjectId().toString();

    await conversationModel.collection.insertOne({
      conversationId,
      user: new mongoose.Types.ObjectId().toString(),
      title: 'Legacy Temporary Conversation',
      endpoint: EModelEndpoint.openAI,
      expiredAt: new Date(Date.now() + 60 * 60 * 1000),
      _meiliIndex: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await conversationModel.syncWithMeili();
    const storedDoc = await conversationModel.collection.findOne({ conversationId });

    expect(mockAddDocuments).not.toHaveBeenCalled();
    expect(storedDoc?._meiliIndex).toBe(false);
  });

  test('saving hydrated legacy temporary conversations without isTemporary does NOT index', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    await conversationModel.deleteMany({});
    mockAddDocuments.mockClear();
    mockUpdateDocuments.mockClear();
    const conversationId = new mongoose.Types.ObjectId().toString();

    await conversationModel.collection.insertOne({
      conversationId,
      user: new mongoose.Types.ObjectId().toString(),
      title: 'Legacy Temporary Conversation',
      endpoint: EModelEndpoint.openAI,
      expiredAt: new Date(Date.now() + 60 * 60 * 1000),
      _meiliIndex: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const legacyConvo = await conversationModel.findOne({ conversationId });
    expect(legacyConvo).toBeTruthy();

    legacyConvo!.title = 'Updated Legacy Temporary Conversation';
    await legacyConvo!.save();
    const storedDoc = await conversationModel.collection.findOne({ conversationId });

    expect(mockAddDocuments).not.toHaveBeenCalled();
    expect(mockUpdateDocuments).not.toHaveBeenCalled();
    expect(storedDoc?._meiliIndex).toBe(false);
  });

  test('findOneAndUpdate on legacy temporary conversations without isTemporary does NOT index', async () => {
    const conversationModel = createConversationModel(
      mongoose,
    ) as unknown as SchemaWithMeiliMethods;
    await conversationModel.deleteMany({});
    mockAddDocuments.mockClear();
    mockUpdateDocuments.mockClear();
    const conversationId = new mongoose.Types.ObjectId().toString();

    await conversationModel.collection.insertOne({
      conversationId,
      user: new mongoose.Types.ObjectId().toString(),
      title: 'Legacy Temporary Conversation',
      endpoint: EModelEndpoint.openAI,
      expiredAt: new Date(Date.now() + 60 * 60 * 1000),
      _meiliIndex: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await conversationModel.findOneAndUpdate(
      { conversationId },
      { $set: { title: 'Updated via findOneAndUpdate' } },
      { new: true },
    );
    const storedDoc = await conversationModel.collection.findOne({ conversationId });

    expect(mockAddDocuments).not.toHaveBeenCalled();
    expect(mockUpdateDocuments).not.toHaveBeenCalled();
    expect(storedDoc?._meiliIndex).toBe(false);
  });

  // [knauf] guard unmatched updates used by partial-message persistence
  test('findOneAndUpdate with no matching document skips Meili post-processing', async () => {
    const modelName = `DynamicMeiliMissingUpdate${new mongoose.Types.ObjectId().toString()}`;
    const dynamicModel = createDynamicMeiliModel(modelName);

    try {
      await expect(
        dynamicModel.findOneAndUpdate(
          { docId: 'missing' },
          { $set: { title: 'Never updated' } },
          { new: true, upsert: false },
        ),
      ).resolves.toBeNull();
      expect(mockUpdateDocuments).not.toHaveBeenCalled();
    } finally {
      await dynamicModel.deleteMany({});
      mongoose.deleteModel(modelName);
    }
  });
  // End [knauf]

  test('sync w/ meili excludes legacy temporary messages without isTemporary', async () => {
    const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
    await messageModel.deleteMany({});
    mockAddDocuments.mockClear();
    const messageId = new mongoose.Types.ObjectId().toString();

    await messageModel.collection.insertOne({
      messageId,
      conversationId: new mongoose.Types.ObjectId().toString(),
      user: new mongoose.Types.ObjectId().toString(),
      isCreatedByUser: true,
      text: 'Legacy temporary message',
      expiredAt: new Date(Date.now() + 60 * 60 * 1000),
      _meiliIndex: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await messageModel.syncWithMeili();
    const storedDoc = await messageModel.collection.findOne({ messageId });

    expect(mockAddDocuments).not.toHaveBeenCalled();
    expect(storedDoc?._meiliIndex).toBe(false);
  });

  test('sync w/ meili treats null isTemporary with no expiration like missing legacy fields', async () => {
    const modelName = `DynamicMeiliNullTemporary${new mongoose.Types.ObjectId().toString()}`;
    const dynamicModel = createDynamicMeiliModel(modelName);
    mockAddDocuments.mockClear();

    try {
      await dynamicModel.collection.insertOne({
        docId: 'legacy-null-temporary',
        user: 'user-123',
        title: 'Legacy Null Temporary',
        isTemporary: null as unknown as boolean,
        expiredAt: null,
        _meiliIndex: false,
      });

      const progress = await dynamicModel.getSyncProgress();
      await dynamicModel.syncWithMeili();
      const storedDoc = await dynamicModel.collection.findOne({ docId: 'legacy-null-temporary' });

      expect(progress.totalDocuments).toBe(1);
      expect(mockAddDocuments).toHaveBeenCalled();
      expect(storedDoc?._meiliIndex).toBe(true);
    } finally {
      await mongoose.connection.dropCollection(modelName.toLowerCase()).catch(() => undefined);
      delete mongoose.models[modelName];
    }
  });

  test('sync queries use a fresh expiration cutoff after plugin initialization', async () => {
    const modelName = `DynamicMeiliCutoff${new mongoose.Types.ObjectId().toString()}`;
    const dynamicModel = createDynamicMeiliModel(modelName);
    mockAddDocuments.mockClear();

    try {
      await dynamicModel.collection.insertOne({
        docId: 'expires-soon',
        user: 'user-123',
        title: 'Expires Soon',
        isTemporary: false,
        expiredAt: new Date(Date.now() + 25),
        _meiliIndex: false,
      });

      await wait(100);

      const progress = await dynamicModel.getSyncProgress();
      await dynamicModel.syncWithMeili();
      const storedDoc = await dynamicModel.collection.findOne({ docId: 'expires-soon' });

      expect(progress.totalDocuments).toBe(0);
      expect(mockAddDocuments).not.toHaveBeenCalled();
      expect(storedDoc?._meiliIndex).toBe(false);
    } finally {
      await dynamicModel.deleteMany({});
      mongoose.deleteModel(modelName);
    }
  });

  describe('estimatedDocumentCount usage in syncWithMeili', () => {
    test('syncWithMeili completes successfully with estimatedDocumentCount', async () => {
      // Clear any previous documents
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      // Create test documents
      await conversationModel.create({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test Conversation 1',
        endpoint: EModelEndpoint.openAI,
      });

      await conversationModel.create({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test Conversation 2',
        endpoint: EModelEndpoint.openAI,
      });

      // Trigger sync - should use estimatedDocumentCount internally
      await expect(conversationModel.syncWithMeili()).resolves.not.toThrow();

      // Verify documents were processed
      expect(mockAddDocuments).toHaveBeenCalled();
    });

    test('syncWithMeili handles empty collection correctly', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      // Verify collection is empty
      const count = await messageModel.estimatedDocumentCount();
      expect(count).toBe(0);

      // Sync should complete without error even with 0 estimated documents
      await expect(messageModel.syncWithMeili()).resolves.not.toThrow();
    });

    test('estimatedDocumentCount returns count for non-empty collection', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      // Create documents
      await conversationModel.create({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test 1',
        endpoint: EModelEndpoint.openAI,
      });

      await conversationModel.create({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test 2',
        endpoint: EModelEndpoint.openAI,
      });

      const estimatedCount = await conversationModel.estimatedDocumentCount();
      expect(estimatedCount).toBeGreaterThanOrEqual(2);
    });

    test('estimatedDocumentCount is available on model', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;

      // Verify the method exists and is callable
      expect(typeof messageModel.estimatedDocumentCount).toBe('function');

      // Should be able to call it
      const result = await messageModel.estimatedDocumentCount();
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThanOrEqual(0);
    });

    test('syncWithMeili handles mix of syncable and TTL documents correctly', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});
      mockAddDocuments.mockClear();

      // Create syncable documents (expiredAt: null)
      await messageModel.create({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: true,
        expiredAt: null,
      });

      await messageModel.create({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: false,
        expiredAt: null,
      });

      // Create TTL documents (expiredAt set to a date)
      await messageModel.create({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: true,
        isTemporary: true,
        expiredAt: new Date(),
      });

      await messageModel.create({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: false,
        isTemporary: true,
        expiredAt: new Date(),
      });

      // estimatedDocumentCount should count all documents (both syncable and TTL)
      const estimatedCount = await messageModel.estimatedDocumentCount();
      expect(estimatedCount).toBe(4);

      // Actual syncable documents (expiredAt: null)
      const syncableCount = await messageModel.countDocuments({ expiredAt: null });
      expect(syncableCount).toBe(2);

      // Sync should complete successfully even though estimated count is higher than processed count
      await expect(messageModel.syncWithMeili()).resolves.not.toThrow();

      // Only syncable documents should be indexed (2 documents, not 4)
      // The mock should be called once per batch, and we have 2 documents
      expect(mockAddDocuments).toHaveBeenCalled();

      // Verify that only 2 documents were indexed (the syncable ones)
      const indexedCount = await messageModel.countDocuments({ _meiliIndex: true });
      expect(indexedCount).toBe(2);
    });
  });

  describe('New batch processing and retry functionality', () => {
    // [knauf] Pin one explicit Meilisearch task per reconciliation cohort.
    test('processSyncBatch submits one explicit Meilisearch task', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocuments.mockClear();

      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test Conversation',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: null,
      });

      // Run sync which should call processSyncBatch internally
      await conversationModel.syncWithMeili();

      // Verify addDocuments was called with explicit primaryKey
      expect(mockAddDocuments).toHaveBeenCalledWith(expect.any(Array), {
        primaryKey: 'conversationId',
      });
      expect(mockAddDocumentsInBatches).not.toHaveBeenCalled();
      expect(mockWaitForTask).toHaveBeenCalledWith(1, {
        timeOutMs: 10_000,
        intervalMs: 250,
      });
    });
    // End [knauf]

    // [knauf] Keep fast index cleanup independent from bounded Mongo acknowledgement batches.
    test('uses independent cleanup and indexing batch sizes', async () => {
      const modelName = `IndependentCleanupBatch${Date.now()}`;
      const previousCleanupBatchSize = process.env.MEILI_CLEANUP_BATCH_SIZE;
      process.env.MEILI_CLEANUP_BATCH_SIZE = '3';
      const Model = createDynamicMeiliModel(modelName, {
        syncBatchSize: 1,
        syncDelayMs: 1,
      });
      const cleanupSpy = jest.spyOn(Model, 'cleanupMeiliIndex').mockResolvedValue();

      try {
        await Model.collection.insertMany([
          {
            docId: 'cleanup-batch-1',
            user: 'test-user',
            title: 'First document',
            isTemporary: false,
            expiredAt: null,
            _meiliIndex: false,
          },
          {
            docId: 'cleanup-batch-2',
            user: 'test-user',
            title: 'Second document',
            isTemporary: false,
            expiredAt: null,
            _meiliIndex: false,
          },
        ]);
        mockAddDocuments.mockClear();

        await Model.syncWithMeili();

        expect(cleanupSpy).toHaveBeenCalledWith(expect.anything(), 'docId', 3, 1);
        expect(mockAddDocuments.mock.calls.map(([documents]) => documents.length)).toEqual([1, 1]);
      } finally {
        cleanupSpy.mockRestore();
        await Model.deleteMany({});
        mongoose.deleteModel(modelName);
        if (previousCleanupBatchSize === undefined) {
          delete process.env.MEILI_CLEANUP_BATCH_SIZE;
        } else {
          process.env.MEILI_CLEANUP_BATCH_SIZE = previousCleanupBatchSize;
        }
      }
    });
    // End [knauf]

    // [knauf] Prove larger submissions retain bounded, paced, fail-closed Mongo acknowledgements.
    test('submits a larger cohort while acknowledging Mongo in bounded chunks', async () => {
      const modelName = `IndependentSubmissionBatch${Date.now()}`;
      const previousSubmissionBatchSize = process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE;
      process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE = '3';
      const Model = createDynamicMeiliModel(modelName, {
        syncBatchSize: 1,
        syncDelayMs: 1,
      });
      const updateManySpy = jest.spyOn(Model, 'updateMany');

      try {
        await Model.collection.insertMany([
          {
            docId: 'submission-batch-1',
            user: 'test-user',
            title: 'First document',
            isTemporary: false,
            expiredAt: null,
            _meiliIndex: false,
          },
          {
            docId: 'submission-batch-2',
            user: 'test-user',
            title: 'Second document',
            isTemporary: false,
            expiredAt: null,
            _meiliIndex: false,
          },
          {
            docId: 'submission-batch-3',
            user: 'test-user',
            title: 'Third document',
            isTemporary: false,
            expiredAt: null,
            _meiliIndex: false,
          },
        ]);
        mockAddDocuments.mockClear();

        await Model.syncWithMeili();

        expect(mockAddDocuments.mock.calls.map(([documents]) => documents.length)).toEqual([3]);
        expect(
          updateManySpy.mock.calls.map(([filter]) => (filter.$or as unknown[]).length),
        ).toEqual([1, 1, 1]);
      } finally {
        updateManySpy.mockRestore();
        await Model.deleteMany({});
        mongoose.deleteModel(modelName);
        if (previousSubmissionBatchSize === undefined) {
          delete process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE;
        } else {
          process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE = previousSubmissionBatchSize;
        }
      }
    });

    test('paces Mongo acknowledgement chunks with the configured delay', async () => {
      const modelName = `PacedAcknowledgementChunks${Date.now()}`;
      const Model = createDynamicMeiliModel(modelName, {
        syncBatchSize: 1,
        syncDelayMs: 5,
      });
      const timeoutSpy = jest.spyOn(global, 'setTimeout');

      try {
        await Model.collection.insertMany(
          ['paced-1', 'paced-2', 'paced-3'].map((docId) => ({
            docId,
            user: 'test-user',
            title: docId,
            isTemporary: false,
            expiredAt: null,
            _meiliIndex: false,
          })),
        );
        const documents = await Model.find({ _meiliIndex: false }).sort({ docId: 1 }).lean();

        await expect(Model.processSyncBatch(mockIndex(), documents)).resolves.toBe(3);

        expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 5)).toHaveLength(2);
      } finally {
        timeoutSpy.mockRestore();
        await Model.deleteMany({});
        mongoose.deleteModel(modelName);
      }
    });

    test('leaves a later acknowledgement chunk retryable when its snapshot changes', async () => {
      const modelName = `ChangedAcknowledgementChunk${Date.now()}`;
      const previousSubmissionBatchSize = process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE;
      process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE = '3';
      const Model = createDynamicMeiliModel(modelName, {
        syncBatchSize: 1,
        syncDelayMs: 1,
      });
      const originalUpdateMany = Model.updateMany.bind(Model);
      let acknowledgementCalls = 0;
      const updateManySpy = jest
        .spyOn(Model, 'updateMany')
        .mockImplementation(async (filter, update, options) => {
          const result = await originalUpdateMany(filter, update, options);
          acknowledgementCalls += 1;
          if (acknowledgementCalls === 1) {
            await Model.collection.updateOne(
              { docId: 'changed-later' },
              {
                $set: {
                  title: 'Changed after task success',
                  updatedAt: new Date('2026-09-07T12:00:00.000Z'),
                },
              },
            );
          }
          return result;
        });

      try {
        await Model.collection.insertMany([
          {
            docId: 'acknowledged-first',
            user: 'test-user',
            title: 'First document',
            isTemporary: false,
            expiredAt: null,
            _meiliIndex: false,
            updatedAt: new Date('2026-09-07T10:00:00.000Z'),
          },
          {
            docId: 'acknowledged-second',
            user: 'test-user',
            title: 'Second document',
            isTemporary: false,
            expiredAt: null,
            _meiliIndex: false,
            updatedAt: new Date('2026-09-07T10:00:00.000Z'),
          },
          {
            docId: 'changed-later',
            user: 'test-user',
            title: 'Third document',
            isTemporary: false,
            expiredAt: null,
            _meiliIndex: false,
            updatedAt: new Date('2026-09-07T10:00:00.000Z'),
          },
        ]);
        const documents = await Model.find({ _meiliIndex: false }).sort({ docId: 1 }).lean();

        await expect(Model.processSyncBatch(mockIndex(), documents)).resolves.toBe(2);

        expect(await Model.countDocuments({ _meiliIndex: true })).toBe(2);
        expect(
          await Model.countDocuments({ docId: 'changed-later', _meiliIndex: { $ne: true } }),
        ).toBe(1);

        updateManySpy.mockImplementation((filter, update, options) =>
          originalUpdateMany(filter, update, options),
        );
        mockAddDocuments.mockClear();
        await Model.syncWithMeili();
        expect(mockAddDocuments).toHaveBeenCalledWith(
          [expect.objectContaining({ title: 'Changed after task success' })],
          { primaryKey: 'docId' },
        );
      } finally {
        updateManySpy.mockRestore();
        await Model.deleteMany({});
        mongoose.deleteModel(modelName);
        if (previousSubmissionBatchSize === undefined) {
          delete process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE;
        } else {
          process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE = previousSubmissionBatchSize;
        }
      }
    });

    test('stops after a failed acknowledgement chunk and preserves earlier commits', async () => {
      const modelName = `FailedAcknowledgementChunk${Date.now()}`;
      const previousSubmissionBatchSize = process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE;
      process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE = '3';
      const Model = createDynamicMeiliModel(modelName, {
        syncBatchSize: 1,
        syncDelayMs: 1,
      });
      const originalUpdateMany = Model.updateMany.bind(Model);
      const updateManySpy = jest
        .spyOn(Model, 'updateMany')
        .mockImplementationOnce((filter, update, options) =>
          originalUpdateMany(filter, update, options),
        )
        .mockRejectedValueOnce(new Error('Mongo acknowledgement failed'));

      try {
        await Model.collection.insertMany([
          {
            docId: 'chunk-1',
            user: 'test-user',
            title: 'First document',
            isTemporary: false,
            expiredAt: null,
            _meiliIndex: false,
          },
          {
            docId: 'chunk-2',
            user: 'test-user',
            title: 'Second document',
            isTemporary: false,
            expiredAt: null,
            _meiliIndex: false,
          },
          {
            docId: 'chunk-3',
            user: 'test-user',
            title: 'Third document',
            isTemporary: false,
            expiredAt: null,
            _meiliIndex: false,
          },
        ]);
        const documents = await Model.find({ _meiliIndex: false }).sort({ docId: 1 }).lean();

        await expect(Model.processSyncBatch(mockIndex(), documents)).rejects.toThrow(
          'Mongo acknowledgement failed',
        );

        expect(updateManySpy).toHaveBeenCalledTimes(2);
        expect(await Model.countDocuments({ docId: 'chunk-1', _meiliIndex: true })).toBe(1);
        expect(
          await Model.countDocuments({
            docId: { $in: ['chunk-2', 'chunk-3'] },
            _meiliIndex: true,
          }),
        ).toBe(0);
      } finally {
        updateManySpy.mockRestore();
        await Model.deleteMany({});
        mongoose.deleteModel(modelName);
        if (previousSubmissionBatchSize === undefined) {
          delete process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE;
        } else {
          process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE = previousSubmissionBatchSize;
        }
      }
    });

    test.each(['', '0', '-1', '3junk', '101', '9007199254740992'])(
      'rejects invalid acknowledgement batch size %p',
      (batchSize) => {
        const previousBatchSize = process.env.MEILI_SYNC_BATCH_SIZE;
        process.env.MEILI_SYNC_BATCH_SIZE = batchSize;

        try {
          expect(() => createDynamicMeiliModel(`InvalidAckBatch${Date.now()}`)).toThrow(
            'MEILI_SYNC_BATCH_SIZE must be a positive integer no greater than 100',
          );
        } finally {
          if (previousBatchSize === undefined) {
            delete process.env.MEILI_SYNC_BATCH_SIZE;
          } else {
            process.env.MEILI_SYNC_BATCH_SIZE = previousBatchSize;
          }
        }
      },
    );

    test.each(['', '0', '-1', '3junk', '1001', '9007199254740992'])(
      'rejects invalid submission batch size %p',
      (submissionBatchSize) => {
        const previousSubmissionBatchSize = process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE;
        process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE = submissionBatchSize;

        try {
          expect(() => createDynamicMeiliModel(`InvalidSubmissionBatch${Date.now()}`)).toThrow(
            'MEILI_SYNC_SUBMISSION_BATCH_SIZE must be a positive integer no greater than 1000',
          );
        } finally {
          if (previousSubmissionBatchSize === undefined) {
            delete process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE;
          } else {
            process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE = previousSubmissionBatchSize;
          }
        }
      },
    );

    test.each(['', '-1', '3junk', '60001', '9007199254740992'])(
      'rejects invalid sync delay %p',
      (syncDelayMs) => {
        const previousSyncDelayMs = process.env.MEILI_SYNC_DELAY_MS;
        process.env.MEILI_SYNC_DELAY_MS = syncDelayMs;

        try {
          expect(() => createDynamicMeiliModel(`InvalidSyncDelay${Date.now()}`)).toThrow(
            'MEILI_SYNC_DELAY_MS must be a non-negative integer no greater than 60000',
          );
        } finally {
          if (previousSyncDelayMs === undefined) {
            delete process.env.MEILI_SYNC_DELAY_MS;
          } else {
            process.env.MEILI_SYNC_DELAY_MS = previousSyncDelayMs;
          }
        }
      },
    );

    test.each([-1, 1.5, 60001, Number.MAX_SAFE_INTEGER + 1])(
      'rejects invalid sync delay plugin override %p',
      (syncDelayMs) => {
        expect(() =>
          createDynamicMeiliModel(`InvalidSyncDelayOption${Date.now()}`, { syncDelayMs }),
        ).toThrow('MEILI_SYNC_DELAY_MS must be a non-negative integer no greater than 60000');
      },
    );

    test('accepts an explicit zero sync delay plugin override', () => {
      const modelName = `ZeroSyncDelay${Date.now()}`;
      expect(() => createDynamicMeiliModel(modelName, { syncDelayMs: 0 })).not.toThrow();
      mongoose.deleteModel(modelName);
    });
    // End [knauf]

    // [knauf] Reject malformed cleanup limits before reconciliation starts.
    test.each(['', '0', '-1', '3junk', '9007199254740992'])(
      'rejects invalid cleanup batch size %p',
      (cleanupBatchSize) => {
        const previousCleanupBatchSize = process.env.MEILI_CLEANUP_BATCH_SIZE;
        process.env.MEILI_CLEANUP_BATCH_SIZE = cleanupBatchSize;

        try {
          expect(() => createDynamicMeiliModel(`InvalidCleanupBatch${Date.now()}`)).toThrow(
            'MEILI_CLEANUP_BATCH_SIZE must be a positive integer',
          );
        } finally {
          if (previousCleanupBatchSize === undefined) {
            delete process.env.MEILI_CLEANUP_BATCH_SIZE;
          } else {
            process.env.MEILI_CLEANUP_BATCH_SIZE = previousCleanupBatchSize;
          }
        }
      },
    );
    // End [knauf]

    // [knauf] Fence task snapshots, requeue concurrent changes, and bound unstable retries.
    test('does not mark Mongo documents indexed before the Meilisearch task succeeds', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      let finishTask: ((task: { status: string }) => void) | undefined;
      mockWaitForTask.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishTask = resolve;
          }),
      );

      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Wait for Meilisearch',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: null,
      });

      const syncing = conversationModel.syncWithMeili();
      while (mockWaitForTask.mock.calls.length === 0) {
        await wait(1);
      }
      expect(await conversationModel.countDocuments({ _meiliIndex: true })).toBe(0);

      finishTask?.({ status: 'succeeded' });
      await syncing;
      expect(await conversationModel.countDocuments({ _meiliIndex: true })).toBe(1);
    });

    test('acknowledges an explicit null updatedAt snapshot without requeueing it', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      const _id = new mongoose.Types.ObjectId();
      await conversationModel.collection.insertOne({
        _id,
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Null timestamp snapshot',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: null,
        updatedAt: null,
      });

      await expect(conversationModel.syncWithMeili()).resolves.toBeUndefined();

      expect(mockAddDocuments).toHaveBeenCalledTimes(1);
      expect(await conversationModel.countDocuments({ _id, _meiliIndex: true })).toBe(1);
    });

    test('requeues a Mongo document changed while its task was running', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      let finishTask: ((task: { status: string }) => void) | undefined;
      mockWaitForTask.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishTask = resolve;
          }),
      );
      const _id = new mongoose.Types.ObjectId();
      const originalUpdatedAt = new Date('2026-09-01T10:00:00.000Z');
      await conversationModel.collection.insertOne({
        _id,
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Original snapshot',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: null,
        updatedAt: originalUpdatedAt,
      });

      const syncing = conversationModel.syncWithMeili();
      while (mockWaitForTask.mock.calls.length === 0) {
        await wait(1);
      }
      await conversationModel.collection.updateOne(
        { _id },
        {
          $set: {
            title: 'Newer snapshot',
            updatedAt: new Date(originalUpdatedAt.getTime() + 1000),
          },
        },
      );
      finishTask?.({ status: 'succeeded' });
      await syncing;

      expect(mockAddDocuments).toHaveBeenCalledTimes(2);
      expect(mockAddDocuments).toHaveBeenLastCalledWith(
        [expect.objectContaining({ title: 'Newer snapshot' })],
        { primaryKey: 'conversationId' },
      );
      expect(await conversationModel.countDocuments({ _id, _meiliIndex: true })).toBe(1);
    });

    test('uses submission cohorts to bound repeated retry passes', async () => {
      const modelName = `UnstableSync${Date.now()}`;
      const previousSubmissionBatchSize = process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE;
      process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE = '3';
      const Model = createDynamicMeiliModel(modelName, {
        syncBatchSize: 1,
        syncDelayMs: 1,
      });
      let updateVersion = 0;
      try {
        await Model.collection.insertMany(
          ['unstable-1', 'unstable-2', 'unstable-3'].map((docId) => ({
            docId,
            user: 'user',
            title: 'Initial title',
            isTemporary: false,
            expiredAt: null,
            _meiliIndex: false,
            updatedAt: new Date(0),
          })),
        );
        mockWaitForTask.mockImplementation(async () => {
          updateVersion += 1;
          await Model.collection.updateMany(
            { docId: { $in: ['unstable-1', 'unstable-2', 'unstable-3'] } },
            {
              $set: {
                title: `Updated ${updateVersion}`,
                updatedAt: new Date(updateVersion),
              },
            },
          );
          return { status: 'succeeded' };
        });

        await expect(Model.syncWithMeili()).rejects.toThrow(
          '[syncWithMeili] Reconciliation did not converge after 11 batches',
        );
        expect(mockAddDocuments).toHaveBeenCalledTimes(11);
      } finally {
        await Model.deleteMany({});
        mongoose.deleteModel(modelName);
        if (previousSubmissionBatchSize === undefined) {
          delete process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE;
        } else {
          process.env.MEILI_SYNC_SUBMISSION_BATCH_SIZE = previousSubmissionBatchSize;
        }
      }
    });
    // End [knauf]

    test('addObjectToMeili retries on failure', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;

      // Mock addDocuments to fail twice then succeed
      mockAddDocuments
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({});

      // Create a document which triggers addObjectToMeili
      await conversationModel.create({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test Retry',
        endpoint: EModelEndpoint.openAI,
      });

      // Wait for async operations to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify addDocuments was called multiple times due to retries
      expect(mockAddDocuments).toHaveBeenCalledTimes(3);
    });

    test('getSyncProgress returns accurate progress information', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      // Insert documents directly to control the _meiliIndex flag
      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Indexed',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: true,
        expiredAt: null,
      });

      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Not Indexed',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: null,
      });

      const progress = await conversationModel.getSyncProgress();

      expect(progress.totalDocuments).toBe(2);
      expect(progress.totalProcessed).toBe(1);
      expect(progress.isComplete).toBe(false);
    });

    test('getSyncProgress excludes TTL documents from counts', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      // Insert syncable documents (expiredAt: null)
      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Syncable Indexed',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: true,
        expiredAt: null,
      });

      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Syncable Not Indexed',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: null,
      });

      // Insert TTL documents (expiredAt set) - these should NOT be counted
      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'TTL Document 1',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: true,
        expiredAt: new Date(),
      });

      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'TTL Document 2',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: new Date(),
      });

      const progress = await conversationModel.getSyncProgress();

      // Only syncable documents should be counted (2 total, 1 indexed)
      expect(progress.totalDocuments).toBe(2);
      expect(progress.totalProcessed).toBe(1);
      expect(progress.isComplete).toBe(false);
    });

    test('getSyncProgress shows completion when all syncable documents are indexed', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      // All syncable documents are indexed
      await messageModel.collection.insertOne({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: true,
        _meiliIndex: true,
        expiredAt: null,
      });

      await messageModel.collection.insertOne({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: false,
        _meiliIndex: true,
        expiredAt: null,
      });

      // Add TTL document - should not affect completion status
      await messageModel.collection.insertOne({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: true,
        _meiliIndex: false,
        expiredAt: new Date(),
      });

      const progress = await messageModel.getSyncProgress();

      expect(progress.totalDocuments).toBe(2);
      expect(progress.totalProcessed).toBe(2);
      expect(progress.isComplete).toBe(true);
    });
  });

  // [knauf] Adapt bulk reconciliation error coverage to the explicit one-task submission path.
  describe('Error handling in processSyncBatch', () => {
    test('syncWithMeili fails when processSyncBatch encounters addDocuments error', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocuments.mockClear();

      // Insert a document to sync
      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test Conversation',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: null,
      });

      // Mock addDocuments to fail
      mockAddDocuments.mockRejectedValueOnce(new Error('MeiliSearch connection error'));

      // Sync should throw the error
      await expect(conversationModel.syncWithMeili()).rejects.toThrow(
        'MeiliSearch connection error',
      );

      // Verify the error was logged
      expect(mockAddDocuments).toHaveBeenCalled();

      // Document should NOT be marked as indexed since sync failed
      // Note: direct collection.insertOne doesn't set default values, so _meiliIndex may be undefined
      const doc = await conversationModel.findOne({});
      expect(doc?._meiliIndex).not.toBe(true);
    });

    test('syncWithMeili fails when processSyncBatch encounters updateMany error', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocuments.mockClear();

      // Insert a document
      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test Conversation',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: null,
      });

      // Mock addDocuments to succeed but simulate updateMany failure
      mockAddDocuments.mockResolvedValueOnce({ taskUid: 1 });

      // Spy on updateMany and make it fail
      const updateManySpy = jest
        .spyOn(conversationModel, 'updateMany')
        .mockRejectedValueOnce(new Error('Database connection error'));

      // Sync should throw the error
      await expect(conversationModel.syncWithMeili()).rejects.toThrow('Database connection error');

      expect(updateManySpy).toHaveBeenCalled();

      // Restore original implementation
      updateManySpy.mockRestore();
    });

    test('processSyncBatch logs error and throws when addDocuments fails', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      mockAddDocuments.mockRejectedValueOnce(new Error('Network timeout'));

      await messageModel.collection.insertOne({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: true,
        _meiliIndex: false,
        expiredAt: null,
      });

      const indexMock = mockIndex();
      const documents = await messageModel.find({ _meiliIndex: false }).lean();

      // Should throw the error
      await expect(messageModel.processSyncBatch(indexMock, documents)).rejects.toThrow(
        'Network timeout',
      );

      expect(mockAddDocuments).toHaveBeenCalled();
    });

    test('processSyncBatch handles empty document array gracefully', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      const indexMock = mockIndex();

      // Should not throw with empty array
      await expect(conversationModel.processSyncBatch(indexMock, [])).resolves.toBe(0);

      // Should not call addDocuments
      expect(mockAddDocuments).not.toHaveBeenCalled();
    });

    test('syncWithMeili stops processing when batch fails and does not process remaining documents', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocuments.mockClear();

      // Create multiple documents
      for (let i = 0; i < 5; i++) {
        await conversationModel.collection.insertOne({
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: `Test Conversation ${i}`,
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: false,
          expiredAt: null,
        });
      }

      // Mock addDocuments to fail on first call
      mockAddDocuments.mockRejectedValueOnce(new Error('First batch failed'));

      // Sync should fail on the first batch
      await expect(conversationModel.syncWithMeili()).rejects.toThrow('First batch failed');

      // Should have attempted only once before failing
      expect(mockAddDocuments).toHaveBeenCalledTimes(1);

      // No documents should be indexed since sync failed
      const indexedCount = await conversationModel.countDocuments({ _meiliIndex: true });
      expect(indexedCount).toBe(0);
    });

    test('error in processSyncBatch is properly logged before being thrown', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      const testError = new Error('Test error for logging');
      mockAddDocuments.mockRejectedValueOnce(testError);

      await messageModel.collection.insertOne({
        messageId: new mongoose.Types.ObjectId(),
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: true,
        _meiliIndex: false,
        expiredAt: null,
      });

      const indexMock = mockIndex();
      const documents = await messageModel.find({ _meiliIndex: false }).lean();

      // Should throw the same error that was passed to it
      await expect(messageModel.processSyncBatch(indexMock, documents)).rejects.toThrow(testError);
    });

    test('syncWithMeili properly propagates processSyncBatch errors', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocuments.mockClear();

      await conversationModel.collection.insertOne({
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        title: 'Test',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: false,
        expiredAt: null,
      });

      const customError = new Error('Custom sync error');
      mockAddDocuments.mockRejectedValueOnce(customError);

      // The error should propagate all the way up
      await expect(conversationModel.syncWithMeili()).rejects.toThrow('Custom sync error');
    });
  });
  // End [knauf]

  describe('cleanupMeiliIndex', () => {
    let mockGetDocuments: jest.Mock;

    beforeEach(() => {
      mockGetDocuments = jest.fn();
      mockDeleteDocuments.mockClear();
      mockIndex.mockReturnValue({
        getRawInfo: jest.fn(),
        updateSettings: jest.fn(),
        addDocuments: mockAddDocuments,
        addDocumentsInBatches: mockAddDocumentsInBatches,
        updateDocuments: mockUpdateDocuments,
        deleteDocument: mockDeleteDocument,
        deleteDocuments: mockDeleteDocuments,
        getDocument: mockGetDocument,
        getDocuments: mockGetDocuments,
      });
    });

    test('cleanupMeiliIndex deletes orphaned documents from MeiliSearch', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      const existingConvoId = new mongoose.Types.ObjectId().toString();
      const orphanedConvoId1 = new mongoose.Types.ObjectId().toString();
      const orphanedConvoId2 = new mongoose.Types.ObjectId().toString();

      // Create one document in MongoDB
      await conversationModel.collection.insertOne({
        conversationId: existingConvoId,
        user: new mongoose.Types.ObjectId(),
        title: 'Existing Conversation',
        endpoint: EModelEndpoint.openAI,
        _meiliIndex: true,
        expiredAt: null,
      });

      // Mock MeiliSearch to return 3 documents (1 exists in MongoDB, 2 are orphaned)
      mockGetDocuments.mockResolvedValueOnce({
        results: [
          { conversationId: existingConvoId },
          { conversationId: orphanedConvoId1 },
          { conversationId: orphanedConvoId2 },
        ],
      });

      const indexMock = mockIndex();
      await conversationModel.cleanupMeiliIndex(indexMock, 'conversationId', 100, 0);

      // Should delete the 2 orphaned documents
      expect(mockDeleteDocuments).toHaveBeenCalledWith([orphanedConvoId1, orphanedConvoId2]);
    });

    test('cleanupMeiliIndex handles offset correctly when documents are deleted', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      const existingIds = [
        new mongoose.Types.ObjectId().toString(),
        new mongoose.Types.ObjectId().toString(),
        new mongoose.Types.ObjectId().toString(),
      ];

      const orphanedIds = [
        new mongoose.Types.ObjectId().toString(),
        new mongoose.Types.ObjectId().toString(),
      ];

      // Create existing documents in MongoDB
      for (const id of existingIds) {
        await messageModel.collection.insertOne({
          messageId: id,
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          _meiliIndex: true,
          expiredAt: null,
        });
      }

      // Mock MeiliSearch to return batches with mixed existing and orphaned documents
      // First batch: 3 documents (1 existing, 2 orphaned) with batchSize=3
      mockGetDocuments
        .mockResolvedValueOnce({
          results: [
            { messageId: existingIds[0] },
            { messageId: orphanedIds[0] },
            { messageId: orphanedIds[1] },
          ],
        })
        // Second batch: should use offset=1 (3 - 2 deleted = 1)
        // results.length=2 < batchSize=3, so loop should stop after this
        .mockResolvedValueOnce({
          results: [{ messageId: existingIds[1] }, { messageId: existingIds[2] }],
        });

      const indexMock = mockIndex();
      await messageModel.cleanupMeiliIndex(indexMock, 'messageId', 3, 0);

      // Should have called getDocuments with correct offsets
      expect(mockGetDocuments).toHaveBeenCalledTimes(2);
      expect(mockGetDocuments).toHaveBeenNthCalledWith(1, { limit: 3, offset: 0 });
      // After deleting 2 documents, offset should be: 0 + (3 - 2) = 1
      expect(mockGetDocuments).toHaveBeenNthCalledWith(2, { limit: 3, offset: 1 });

      // Should delete only the orphaned documents
      expect(mockDeleteDocuments).toHaveBeenCalledWith([orphanedIds[0], orphanedIds[1]]);
    });

    test('cleanupMeiliIndex preserves existing documents', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      const existingId1 = new mongoose.Types.ObjectId().toString();
      const existingId2 = new mongoose.Types.ObjectId().toString();

      // Create documents in MongoDB
      await conversationModel.collection.insertMany([
        {
          conversationId: existingId1,
          user: new mongoose.Types.ObjectId(),
          title: 'Conversation 1',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: true,
          expiredAt: null,
        },
        {
          conversationId: existingId2,
          user: new mongoose.Types.ObjectId(),
          title: 'Conversation 2',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: true,
          expiredAt: null,
        },
      ]);

      // Mock MeiliSearch to return the same documents
      mockGetDocuments.mockResolvedValueOnce({
        results: [{ conversationId: existingId1 }, { conversationId: existingId2 }],
      });

      const indexMock = mockIndex();
      await conversationModel.cleanupMeiliIndex(indexMock, 'conversationId', 100, 0);

      // Should NOT delete any documents
      expect(mockDeleteDocuments).not.toHaveBeenCalled();
    });

    test('cleanupMeiliIndex handles empty MeiliSearch index', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;

      // Mock empty MeiliSearch index
      mockGetDocuments.mockResolvedValueOnce({
        results: [],
      });

      const indexMock = mockIndex();
      await messageModel.cleanupMeiliIndex(indexMock, 'messageId', 100, 0);

      // Should not attempt to delete anything
      expect(mockDeleteDocuments).not.toHaveBeenCalled();
      expect(mockGetDocuments).toHaveBeenCalledTimes(1);
    });

    // [knauf] Missing ephemeral indexes must remain recoverable through the normal bulk sync.
    test('cleanupMeiliIndex treats a missing index as an empty cleanup target', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      const missingIndexError = Object.assign(new Error('Index not found'), {
        code: 'index_not_found',
      });
      mockGetDocuments.mockRejectedValueOnce(missingIndexError);

      const indexMock = mockIndex();

      await expect(
        messageModel.cleanupMeiliIndex(indexMock, 'messageId', 100, 0),
      ).resolves.toBeUndefined();
      expect(mockDeleteDocuments).not.toHaveBeenCalled();
    });
    // End [knauf]

    test('cleanupMeiliIndex stops when results.length < batchSize', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      const id1 = new mongoose.Types.ObjectId().toString();
      const id2 = new mongoose.Types.ObjectId().toString();

      await conversationModel.collection.insertMany([
        {
          conversationId: id1,
          user: new mongoose.Types.ObjectId(),
          title: 'Conversation 1',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: true,
          expiredAt: null,
        },
        {
          conversationId: id2,
          user: new mongoose.Types.ObjectId(),
          title: 'Conversation 2',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: true,
          expiredAt: null,
        },
      ]);

      // Mock: results.length (2) is less than batchSize (100), should process once and stop
      mockGetDocuments.mockResolvedValueOnce({
        results: [{ conversationId: id1 }, { conversationId: id2 }],
      });

      const indexMock = mockIndex();
      await conversationModel.cleanupMeiliIndex(indexMock, 'conversationId', 100, 0);

      // Should only call getDocuments once
      expect(mockGetDocuments).toHaveBeenCalledTimes(1);
      expect(mockDeleteDocuments).not.toHaveBeenCalled();
    });

    test('cleanupMeiliIndex handles multiple batches correctly', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      const existingIds = Array.from({ length: 5 }, () => new mongoose.Types.ObjectId().toString());
      const orphanedIds = Array.from({ length: 3 }, () => new mongoose.Types.ObjectId().toString());

      // Create existing documents in MongoDB
      for (const id of existingIds) {
        await messageModel.collection.insertOne({
          messageId: id,
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          _meiliIndex: true,
          expiredAt: null,
        });
      }

      // Mock multiple batches with batchSize=3
      mockGetDocuments
        // Batch 1: 2 existing, 1 orphaned
        .mockResolvedValueOnce({
          results: [
            { messageId: existingIds[0] },
            { messageId: existingIds[1] },
            { messageId: orphanedIds[0] },
          ],
        })
        // Batch 2: offset should be 0 + (3 - 1) = 2
        .mockResolvedValueOnce({
          results: [
            { messageId: existingIds[2] },
            { messageId: orphanedIds[1] },
            { messageId: orphanedIds[2] },
          ],
        })
        // Batch 3: offset should be 2 + (3 - 2) = 3
        .mockResolvedValueOnce({
          results: [{ messageId: existingIds[3] }, { messageId: existingIds[4] }],
        });

      const indexMock = mockIndex();
      await messageModel.cleanupMeiliIndex(indexMock, 'messageId', 3, 0);

      expect(mockGetDocuments).toHaveBeenCalledTimes(3);
      expect(mockGetDocuments).toHaveBeenNthCalledWith(1, { limit: 3, offset: 0 });
      expect(mockGetDocuments).toHaveBeenNthCalledWith(2, { limit: 3, offset: 2 });
      expect(mockGetDocuments).toHaveBeenNthCalledWith(3, { limit: 3, offset: 3 });

      // Should have deleted orphaned documents in batches
      expect(mockDeleteDocuments).toHaveBeenCalledTimes(2);
      expect(mockDeleteDocuments).toHaveBeenNthCalledWith(1, [orphanedIds[0]]);
      expect(mockDeleteDocuments).toHaveBeenNthCalledWith(2, [orphanedIds[1], orphanedIds[2]]);
    });

    test('cleanupMeiliIndex handles delay between batches', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      const id1 = new mongoose.Types.ObjectId().toString();
      const id2 = new mongoose.Types.ObjectId().toString();

      await conversationModel.collection.insertMany([
        {
          conversationId: id1,
          user: new mongoose.Types.ObjectId(),
          title: 'Conversation 1',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: true,
          expiredAt: null,
        },
        {
          conversationId: id2,
          user: new mongoose.Types.ObjectId(),
          title: 'Conversation 2',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: true,
          expiredAt: null,
        },
      ]);

      mockGetDocuments
        .mockResolvedValueOnce({
          results: [{ conversationId: id1 }],
        })
        .mockResolvedValueOnce({
          results: [{ conversationId: id2 }],
        })
        .mockResolvedValueOnce({
          results: [],
        });

      const indexMock = mockIndex();
      const startTime = Date.now();
      await conversationModel.cleanupMeiliIndex(indexMock, 'conversationId', 1, 100);
      const endTime = Date.now();

      // Should have taken at least 200ms due to delay (2 delays between 3 batches)
      expect(endTime - startTime).toBeGreaterThanOrEqual(200);
      expect(mockGetDocuments).toHaveBeenCalledTimes(3);
    });

    // [knauf] Cleanup failures must propagate so reconciliation retains retry semantics.
    test('cleanupMeiliIndex propagates errors', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;

      mockGetDocuments.mockRejectedValueOnce(new Error('MeiliSearch connection error'));

      const indexMock = mockIndex();

      await expect(messageModel.cleanupMeiliIndex(indexMock, 'messageId', 100, 0)).rejects.toThrow(
        'MeiliSearch connection error',
      );
    });
    // End [knauf]

    test('cleanupMeiliIndex with all documents being orphaned', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      const orphanedId1 = new mongoose.Types.ObjectId().toString();
      const orphanedId2 = new mongoose.Types.ObjectId().toString();
      const orphanedId3 = new mongoose.Types.ObjectId().toString();

      // MeiliSearch has documents but MongoDB is empty
      mockGetDocuments.mockResolvedValueOnce({
        results: [
          { conversationId: orphanedId1 },
          { conversationId: orphanedId2 },
          { conversationId: orphanedId3 },
        ],
      });

      const indexMock = mockIndex();
      await conversationModel.cleanupMeiliIndex(indexMock, 'conversationId', 100, 0);

      // Should delete all documents since none exist in MongoDB
      expect(mockDeleteDocuments).toHaveBeenCalledWith([orphanedId1, orphanedId2, orphanedId3]);
    });

    test('cleanupMeiliIndex adjusts offset to 0 when all batch documents are deleted', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      const orphanedIds = Array.from({ length: 3 }, () => new mongoose.Types.ObjectId().toString());
      const existingId = new mongoose.Types.ObjectId().toString();

      // Create one existing document
      await messageModel.collection.insertOne({
        messageId: existingId,
        conversationId: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        isCreatedByUser: true,
        _meiliIndex: true,
        expiredAt: null,
      });

      mockGetDocuments
        // Batch 1: All 3 are orphaned
        .mockResolvedValueOnce({
          results: [
            { messageId: orphanedIds[0] },
            { messageId: orphanedIds[1] },
            { messageId: orphanedIds[2] },
          ],
        })
        // Batch 2: offset should be 0 + (3 - 3) = 0
        .mockResolvedValueOnce({
          results: [{ messageId: existingId }],
        });

      const indexMock = mockIndex();
      await messageModel.cleanupMeiliIndex(indexMock, 'messageId', 3, 0);

      expect(mockGetDocuments).toHaveBeenCalledTimes(2);
      expect(mockGetDocuments).toHaveBeenNthCalledWith(1, { limit: 3, offset: 0 });
      // After deleting all 3, offset remains at 0
      expect(mockGetDocuments).toHaveBeenNthCalledWith(2, { limit: 3, offset: 0 });

      expect(mockDeleteDocuments).toHaveBeenCalledWith([
        orphanedIds[0],
        orphanedIds[1],
        orphanedIds[2],
      ]);
    });
  });

  describe('processSyncBatch does not modify updatedAt timestamps', () => {
    test('syncWithMeili preserves original updatedAt on conversations', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocuments.mockClear();

      const pastDate = new Date('2024-01-15T12:00:00Z');

      // Insert documents with specific updatedAt timestamps using raw collection
      await conversationModel.collection.insertMany([
        {
          conversationId: new mongoose.Types.ObjectId().toString(),
          user: new mongoose.Types.ObjectId(),
          title: 'Old Conversation 1',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: false,
          expiredAt: null,
          createdAt: pastDate,
          updatedAt: pastDate,
        },
        {
          conversationId: new mongoose.Types.ObjectId().toString(),
          user: new mongoose.Types.ObjectId(),
          title: 'Old Conversation 2',
          endpoint: EModelEndpoint.openAI,
          _meiliIndex: false,
          expiredAt: null,
          createdAt: pastDate,
          updatedAt: pastDate,
        },
      ]);

      // Verify timestamps before sync
      const beforeSync = await conversationModel.find({}).lean();
      for (const doc of beforeSync) {
        expect(new Date(doc.updatedAt as Date).getTime()).toBe(pastDate.getTime());
      }

      // Run sync which calls processSyncBatch internally
      await conversationModel.syncWithMeili();

      // Verify _meiliIndex was updated
      const indexedCount = await conversationModel.countDocuments({ _meiliIndex: true });
      expect(indexedCount).toBe(2);

      // Verify updatedAt was NOT modified
      const afterSync = await conversationModel.find({}).lean();
      for (const doc of afterSync) {
        expect(new Date(doc.updatedAt as Date).getTime()).toBe(pastDate.getTime());
      }
    });

    test('syncWithMeili preserves original updatedAt on messages', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});
      mockAddDocuments.mockClear();

      const pastDate = new Date('2023-06-01T08:30:00Z');

      await messageModel.collection.insertMany([
        {
          messageId: new mongoose.Types.ObjectId().toString(),
          conversationId: new mongoose.Types.ObjectId().toString(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          _meiliIndex: false,
          expiredAt: null,
          createdAt: pastDate,
          updatedAt: pastDate,
        },
        {
          messageId: new mongoose.Types.ObjectId().toString(),
          conversationId: new mongoose.Types.ObjectId().toString(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: false,
          _meiliIndex: false,
          expiredAt: null,
          createdAt: pastDate,
          updatedAt: pastDate,
        },
      ]);

      const beforeSync = await messageModel.find({}).lean();
      for (const doc of beforeSync) {
        expect(new Date(doc.updatedAt as Date).getTime()).toBe(pastDate.getTime());
      }

      await messageModel.syncWithMeili();

      const indexedCount = await messageModel.countDocuments({ _meiliIndex: true });
      expect(indexedCount).toBe(2);

      const afterSync = await messageModel.find({}).lean();
      for (const doc of afterSync) {
        expect(new Date(doc.updatedAt as Date).getTime()).toBe(pastDate.getTime());
      }
    });
  });

  describe('Missing _meiliIndex property handling in sync process', () => {
    test('syncWithMeili includes documents with missing _meiliIndex', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocuments.mockClear();

      // Insert documents with different _meiliIndex states
      await conversationModel.collection.insertMany([
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'Missing _meiliIndex',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          // _meiliIndex is not set (missing/undefined)
        },
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'Explicit false',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          _meiliIndex: false,
        },
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'Already indexed',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          _meiliIndex: true,
        },
      ]);

      // Run sync
      await conversationModel.syncWithMeili();

      // Should have processed 2 documents (missing and false, but not true)
      expect(mockAddDocuments).toHaveBeenCalled();

      // Check that both documents without _meiliIndex=true are now indexed
      const indexedCount = await conversationModel.countDocuments({
        expiredAt: null,
        _meiliIndex: true,
      });
      expect(indexedCount).toBe(3); // All 3 should now be indexed

      // Verify documents with missing _meiliIndex were updated
      const docsWithMissingIndex = await conversationModel.countDocuments({
        expiredAt: null,
        title: 'Missing _meiliIndex',
        _meiliIndex: true,
      });
      expect(docsWithMissingIndex).toBe(1);
    });

    test('getSyncProgress counts documents with missing _meiliIndex as not indexed', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});

      // Insert documents with different _meiliIndex states
      await messageModel.collection.insertMany([
        {
          messageId: new mongoose.Types.ObjectId(),
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          expiredAt: null,
          _meiliIndex: true,
        },
        {
          messageId: new mongoose.Types.ObjectId(),
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          expiredAt: null,
          _meiliIndex: false,
        },
        {
          messageId: new mongoose.Types.ObjectId(),
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          expiredAt: null,
          // _meiliIndex is missing
        },
      ]);

      const progress = await messageModel.getSyncProgress();

      // Total should be 3
      expect(progress.totalDocuments).toBe(3);
      // Only 1 is indexed (with _meiliIndex: true)
      expect(progress.totalProcessed).toBe(1);
      // Not complete since 2 documents are not indexed
      expect(progress.isComplete).toBe(false);
    });

    test('query with _meiliIndex: { $ne: true } includes missing values', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});

      // Insert documents with different _meiliIndex states
      await conversationModel.collection.insertMany([
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'Missing',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          // _meiliIndex is missing
        },
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'False',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          _meiliIndex: false,
        },
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'True',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          _meiliIndex: true,
        },
      ]);

      // Query for documents where _meiliIndex is not true (used in syncWithMeili)
      const unindexedDocs = await conversationModel.find({
        expiredAt: null,
        _meiliIndex: { $ne: true },
      });

      // Should find 2 documents (missing and false, but not true)
      expect(unindexedDocs.length).toBe(2);
      const titles = unindexedDocs.map((doc) => doc.title).sort();
      expect(titles).toEqual(['False', 'Missing']);
    });

    test('syncWithMeili processes all documents where _meiliIndex is not true', async () => {
      const messageModel = createMessageModel(mongoose) as unknown as SchemaWithMeiliMethods;
      await messageModel.deleteMany({});
      mockAddDocuments.mockClear();

      // Create a mix of documents with missing and false _meiliIndex
      await messageModel.collection.insertMany([
        {
          messageId: new mongoose.Types.ObjectId(),
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          expiredAt: null,
          // _meiliIndex missing
        },
        {
          messageId: new mongoose.Types.ObjectId(),
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          expiredAt: null,
          _meiliIndex: false,
        },
        {
          messageId: new mongoose.Types.ObjectId(),
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          isCreatedByUser: true,
          expiredAt: null,
          // _meiliIndex missing
        },
      ]);

      // Count documents that should be synced (where _meiliIndex: { $ne: true })
      const toSyncCount = await messageModel.countDocuments({
        expiredAt: null,
        _meiliIndex: { $ne: true },
      });
      expect(toSyncCount).toBe(3); // All 3 should be synced

      await messageModel.syncWithMeili();

      // All should now be indexed
      const indexedCount = await messageModel.countDocuments({
        expiredAt: null,
        _meiliIndex: true,
      });
      expect(indexedCount).toBe(3);
    });

    test('syncWithMeili treats missing _meiliIndex same as false', async () => {
      const conversationModel = createConversationModel(
        mongoose,
      ) as unknown as SchemaWithMeiliMethods;
      await conversationModel.deleteMany({});
      mockAddDocuments.mockClear();

      // Insert one document with missing _meiliIndex and one with false
      await conversationModel.collection.insertMany([
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'Missing',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          // _meiliIndex is missing
        },
        {
          conversationId: new mongoose.Types.ObjectId(),
          user: new mongoose.Types.ObjectId(),
          title: 'False',
          endpoint: EModelEndpoint.openAI,
          expiredAt: null,
          _meiliIndex: false,
        },
      ]);

      // Both should be picked up by the sync query
      const toSync = await conversationModel.find({
        expiredAt: null,
        _meiliIndex: { $ne: true },
      });
      expect(toSync.length).toBe(2);

      await conversationModel.syncWithMeili();

      // Both should be indexed after sync
      const afterSync = await conversationModel.find({
        expiredAt: null,
        _meiliIndex: true,
      });
      expect(afterSync.length).toBe(2);
    });
  });
});
