// [knauf] KK20-204 — unit tests for the per-user content-hash dedup helpers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
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

jest.mock('~/models', () => {
  const m = require('mongoose');
  const { createMethods } = require('@librechat/data-schemas');
  return createMethods(m, { removeAllPermissions: jest.fn() });
});

require('module-alias/register');
const { computeContentHash, findCanonicalForHash } = require('./contentDedup');

describe('contentDedup (KK20-204)', () => {
  describe('computeContentHash', () => {
    test('returns the SHA-256 hex digest of the file bytes', async () => {
      const tmp = path.join(os.tmpdir(), `knauf-dedup-hash-${process.pid}.bin`);
      const bytes = Buffer.from('hello dedup world');
      fs.writeFileSync(tmp, bytes);
      try {
        const expected = crypto.createHash('sha256').update(bytes).digest('hex');
        await expect(computeContentHash(tmp)).resolves.toBe(expected);
      } finally {
        fs.unlinkSync(tmp);
      }
    });
  });

  describe('findCanonicalForHash', () => {
    let mongoServer;
    let File;
    const userId = new mongoose.Types.ObjectId();

    beforeAll(async () => {
      mongoServer = await MongoMemoryServer.create();
      await mongoose.connect(mongoServer.getUri());
      createModels(mongoose);
      createMethods(mongoose, { removeAllPermissions: jest.fn() });
      File = mongoose.models.File;
    }, 30000);

    afterAll(async () => {
      await mongoose.disconnect();
      await mongoServer.stop();
    });

    beforeEach(async () => {
      await File.deleteMany({});
    });

    const seed = (file_id, extra) =>
      File.create({
        file_id,
        user: userId,
        filename: `${file_id}.txt`,
        filepath: `/blob/${file_id}`,
        object: 'file',
        type: 'text/plain',
        bytes: 1,
        source: FileSources.local,
        ...extra,
      });

    test('returns null when the content is new for the user', async () => {
      await expect(
        findCanonicalForHash({ user: userId, knauf_content_hash: 'UNSEEN' }),
      ).resolves.toBeNull();
    });

    test('returns null when knauf_content_hash is falsy', async () => {
      await expect(
        findCanonicalForHash({ user: userId, knauf_content_hash: undefined }),
      ).resolves.toBeNull();
    });

    test('returns the canonical row, ignoring pointer rows', async () => {
      await seed('canon', { knauf_content_hash: 'H' });
      await seed('ptr', { knauf_content_hash: 'H', knauf_canonical_file_id: 'canon' });
      const found = await findCanonicalForHash({ user: userId, knauf_content_hash: 'H' });
      expect(found.file_id).toBe('canon');
    });

    test('returns the oldest canonical when a race left two', async () => {
      await seed('old', { knauf_content_hash: 'H' });
      await seed('new', { knauf_content_hash: 'H' });
      // timestamps:true sets createdAt on insert; override on update to make order deterministic.
      await File.updateOne({ file_id: 'old' }, { $set: { createdAt: new Date('2020-01-01') } });
      await File.updateOne({ file_id: 'new' }, { $set: { createdAt: new Date('2021-01-01') } });
      const found = await findCanonicalForHash({ user: userId, knauf_content_hash: 'H' });
      expect(found.file_id).toBe('old');
    });
  });
});
// End [knauf]
