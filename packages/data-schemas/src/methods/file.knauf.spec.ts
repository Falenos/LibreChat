// [knauf] KK20-195 WP3a — seam test for the owner-scoped createFile upsert:
// a replay by the same owner updates the SAME row; a write scoped to a
// different owner can never modify a foreign row (write-time defense in depth
// behind the route's 409 pre-check).
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IMongoFile } from '~/types';
import { createFileMethods } from './file';
import fileSchema from '~/schema/file';

let mongoServer: MongoMemoryServer;
let File: mongoose.Model<IMongoFile>;
let methods: ReturnType<typeof createFileMethods>;

const userA = new mongoose.Types.ObjectId('64a000000000000000000001');
const userB = new mongoose.Types.ObjectId('64a000000000000000000002');

const baseFile = (overrides: Partial<IMongoFile> = {}): Partial<IMongoFile> => ({
  user: userA,
  file_id: 'shared-uuid-1',
  filepath: '/blob/a',
  bytes: 10,
  filename: 'a.pdf',
  type: 'application/pdf',
  object: 'file' as IMongoFile['object'],
  usage: 0,
  ...overrides,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  File = mongoose.models.File || mongoose.model<IMongoFile>('File', fileSchema);
  methods = createFileMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await File.deleteMany({});
});

describe('createFile with ownerScope (KK20-195 WP3a)', () => {
  test('same-owner replay updates the same row — no duplicate', async () => {
    await methods.createFile(baseFile(), true, { userId: String(userA) });
    const replay = await methods.createFile(baseFile({ bytes: 10, filename: 'a.pdf' }), true, {
      userId: String(userA),
    });
    expect(replay?.file_id).toBe('shared-uuid-1');
    expect(await File.countDocuments({ file_id: 'shared-uuid-1' })).toBe(1);
  });

  test('a differently-owned scope can never modify the foreign row', async () => {
    await methods.createFile(baseFile({ filepath: '/blob/original' }), true, {
      userId: String(userA),
    });

    await methods.createFile(baseFile({ user: userB, filepath: '/blob/attacker' }), true, {
      userId: String(userB),
    });

    const original = await File.findOne({ file_id: 'shared-uuid-1', user: userA }).lean();
    expect(original?.filepath).toBe('/blob/original');
  });

  test('without a scope, behavior is unchanged (by-id upsert)', async () => {
    await methods.createFile(baseFile(), true);
    const updated = await methods.createFile(baseFile({ filepath: '/blob/updated' }), true);
    expect(updated?.filepath).toBe('/blob/updated');
    expect(await File.countDocuments({})).toBe(1);
  });
});
// End [knauf]

// [knauf] KK20-297 — persisted translation outputs use application-managed
// `expiredAt`; disabling the temporary upload TTL removes only `expiresAt`.
describe('translation output retention', () => {
  test('retention expiry survives creation and later conversation binding', async () => {
    const expiredAt = new Date('2030-01-02T03:04:05.000Z');
    const created = await methods.createFile(baseFile({ expiredAt }), true, {
      userId: String(userA),
    });

    expect(created?.expiredAt).toEqual(expiredAt);
    expect(created?.expiresAt).toBeUndefined();

    const bound = await methods.updateFile(
      {
        file_id: 'shared-uuid-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
        expiredAt,
      },
      { user: userA },
    );

    expect(bound).toMatchObject({
      conversationId: 'conversation-1',
      messageId: 'message-1',
      expiredAt,
    });
    expect(bound?.expiresAt).toBeUndefined();
  });
});
// End [knauf]
