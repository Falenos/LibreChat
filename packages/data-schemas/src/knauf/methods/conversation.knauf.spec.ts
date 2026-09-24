import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { EModelEndpoint } from 'librechat-data-provider';
import type { IChatProject, IConversation } from '../../types';
import { createModels } from '../../models';
import { ConversationMethods, createConversationMethods } from '../../methods/conversation';
import logger from '~/config/winston';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let Conversation: mongoose.Model<IConversation>;
let ChatProject: mongoose.Model<IChatProject>;
let methods: ConversationMethods;
let modelsToCleanup: string[] = [];

const getMessages = jest.fn().mockResolvedValue([]);
const deleteMessages = jest.fn().mockResolvedValue({ deletedCount: 0 });
const ctx = { userId: 'user123' };

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const models = createModels(mongoose);
  modelsToCleanup = Object.keys(models);
  Object.assign(mongoose.models, models);
  Conversation = mongoose.models.Conversation as mongoose.Model<IConversation>;
  ChatProject = mongoose.models.ChatProject as mongoose.Model<IChatProject>;
  methods = createConversationMethods(mongoose, { getMessages, deleteMessages });
  await mongoose.connect(mongoServer.getUri());
});

beforeEach(async () => {
  await Conversation.deleteMany({});
  await ChatProject.deleteMany({});
  jest.clearAllMocks();
  getMessages.mockResolvedValue([]);
  deleteMessages.mockResolvedValue({ deletedCount: 0 });
});

afterAll(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
  for (const modelName of modelsToCleanup) {
    delete mongoose.models[modelName];
  }
  await mongoose.disconnect();
  await mongoServer.stop();
});

const saveConvo = (...args: Parameters<ConversationMethods['saveConvo']>) =>
  methods.saveConvo(...args) as Promise<IConversation | null>;
const getConvosByCursor = (...args: Parameters<ConversationMethods['getConvosByCursor']>) =>
  methods.getConvosByCursor(...args);

const rawConversation = (
  conversationId: string,
  updatedAt: Date,
  chatProjectId?: null | string,
  title = conversationId,
) => ({
  user: ctx.userId,
  conversationId,
  title,
  endpoint: EModelEndpoint.openAI,
  createdAt: updatedAt,
  updatedAt,
  isArchived: false,
  isTemporary: false,
  expiredAt: null,
  ...(chatProjectId !== undefined ? { chatProjectId } : {}),
});

describe('KK20-385 conversation persistence', () => {
  it('normalizes cleared, invalid, and metadata-unset project membership to null', async () => {
    const conversationId = uuidv4();
    const project = await ChatProject.create({ user: ctx.userId, name: 'Canonical Project' });

    await saveConvo(ctx, {
      conversationId,
      title: 'Canonical',
      endpoint: EModelEndpoint.openAI,
      chatProjectId: project._id!.toString(),
    });
    await saveConvo(
      ctx,
      { conversationId, chatProjectId: new mongoose.Types.ObjectId().toString() },
      { unsetFields: { chatProjectId: 1 } },
    );

    let saved = await Conversation.findOne({ conversationId }).lean<IConversation>();
    expect(saved?.chatProjectId).toBeNull();

    await saveConvo(ctx, { conversationId, chatProjectId: null });
    saved = await Conversation.findOne({ conversationId }).lean<IConversation>();
    expect(saved?.chatProjectId).toBeNull();

    await saveConvo(ctx, { conversationId }, { unsetFields: { chatProjectId: 1 } });
    saved = await Conversation.findOne({ conversationId }).lean<IConversation>();
    expect(saved?.chatProjectId).toBeNull();
  });
});

describe('KK20-385 conversation pagination', () => {
  it('globally orders mixed missing and null rows across pages', async () => {
    const oldRows = Array.from({ length: 12 }, (_, index) =>
      rawConversation(`legacy-${index}`, new Date(2025, 5, index + 1)),
    );
    const recentRows = Array.from({ length: 30 }, (_, index) =>
      rawConversation(`current-${index}`, new Date(2025, 7, index + 1), null),
    );
    await Conversation.collection.insertMany([...oldRows, ...recentRows]);

    const first = await getConvosByCursor(ctx.userId, {
      limit: 25,
      projectId: 'unassigned',
      sortBy: 'updatedAt',
      sortDirection: 'desc',
    });
    const second = await getConvosByCursor(ctx.userId, {
      limit: 25,
      cursor: first.nextCursor ?? undefined,
      projectId: 'unassigned',
      sortBy: 'updatedAt',
      sortDirection: 'desc',
    });
    const combined = [...first.conversations, ...second.conversations];
    const timestamps = combined.map((conversation) => new Date(conversation.updatedAt).getTime());

    expect(first.conversations).toHaveLength(25);
    expect(first.conversations.every((conversation) => conversation.chatProjectId === null)).toBe(
      true,
    );
    expect(new Set(combined.map((conversation) => conversation.conversationId)).size).toBe(42);
    expect(timestamps).toEqual([...timestamps].sort((left, right) => right - left));
  });

  it.each([
    ['asc', 1],
    ['desc', -1],
  ] as const)('uses _id to paginate identical timestamps in %s order', async (direction, order) => {
    const timestamp = new Date('2025-08-15T12:00:00.000Z');
    await Conversation.collection.insertMany(
      Array.from({ length: 30 }, (_, index) => rawConversation(`tied-${index}`, timestamp, null)),
    );

    const first = await getConvosByCursor(ctx.userId, {
      limit: 25,
      projectId: 'unassigned',
      sortDirection: direction,
    });
    const second = await getConvosByCursor(ctx.userId, {
      limit: 25,
      cursor: first.nextCursor ?? undefined,
      projectId: 'unassigned',
      sortDirection: direction,
    });
    const ids = [...first.conversations, ...second.conversations].map((conversation) =>
      String(conversation._id),
    );

    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    expect(ids).toEqual([...ids].sort((left, right) => left.localeCompare(right) * order));
  });

  it('accepts old cursors and emits additive cursors readable by the old parser', async () => {
    const rows = Array.from({ length: 3 }, (_, index) =>
      rawConversation(`compatible-${index}`, new Date(`2025-08-0${index + 1}T12:00:00.000Z`), null),
    );
    await Conversation.collection.insertMany(rows);
    const oldCursor = Buffer.from(
      JSON.stringify({
        primary: rows[1].updatedAt.toISOString(),
        secondary: rows[1].updatedAt.toISOString(),
      }),
    ).toString('base64');

    const oldBoundaryPage = await getConvosByCursor(ctx.userId, {
      limit: 25,
      cursor: oldCursor,
      projectId: 'unassigned',
    });
    expect(
      oldBoundaryPage.conversations.map((conversation) => conversation.conversationId),
    ).toEqual(['compatible-0']);

    const first = await getConvosByCursor(ctx.userId, {
      limit: 1,
      projectId: 'unassigned',
    });
    const decodedByOldParser = JSON.parse(Buffer.from(first.nextCursor!, 'base64').toString()) as {
      primary: string;
      secondary: string;
    };
    expect(decodedByOldParser.primary).toBeTruthy();
    expect(decodedByOldParser.secondary).toBeTruthy();
  });

  it('sorts mixed missing and null rows by title', async () => {
    await Conversation.collection.insertMany([
      rawConversation('legacy-title', new Date(), undefined, 'Alpha'),
      rawConversation('null-title', new Date(), null, 'Zulu'),
    ]);

    const result = await getConvosByCursor(ctx.userId, {
      projectId: 'unassigned',
      sortBy: 'title',
      sortDirection: 'desc',
    });

    expect(result.conversations.map((conversation) => conversation.title)).toEqual([
      'Zulu',
      'Alpha',
    ]);
  });

  it('falls back only for a recognized missing hint error', async () => {
    await Conversation.collection.insertOne(rawConversation('fallback', new Date(), null));
    const hintSpy = jest.spyOn(mongoose.Query.prototype, 'hint').mockImplementationOnce(() => {
      throw Object.assign(new Error('hint does not correspond to an existing index'), {
        code: 27,
        codeName: 'IndexNotFound',
      });
    });

    try {
      const result = await getConvosByCursor(ctx.userId, { projectId: 'unassigned' });

      expect(result.conversations).toHaveLength(1);
      expect(logger.error).toHaveBeenCalledWith('history_hint_fallback', {
        code: 27,
        name: 'IndexNotFound',
      });
    } finally {
      hintSpy.mockRestore();
    }
  });

  it('does not hint project-specific history', async () => {
    const projectId = new mongoose.Types.ObjectId().toString();
    await Conversation.collection.insertOne(rawConversation('project-chat', new Date(), projectId));
    const hintSpy = jest.spyOn(mongoose.Query.prototype, 'hint');

    try {
      const result = await getConvosByCursor(ctx.userId, { projectId });

      expect(result.conversations.map((conversation) => conversation.conversationId)).toEqual([
        'project-chat',
      ]);
      expect(hintSpy).not.toHaveBeenCalled();
    } finally {
      hintSpy.mockRestore();
    }
  });
});
