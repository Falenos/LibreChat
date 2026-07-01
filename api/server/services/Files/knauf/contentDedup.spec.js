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
const { computeContentHash, findAssetForHash } = require('./contentDedup');

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

  describe('findAssetForHash', () => {
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
        findAssetForHash({ user: userId, knauf_content_hash: 'UNSEEN' }),
      ).resolves.toBeNull();
    });

    test('returns null when knauf_content_hash is falsy', async () => {
      await expect(
        findAssetForHash({ user: userId, knauf_content_hash: undefined }),
      ).resolves.toBeNull();
    });

    test('resolves the shared asset id from any row in the group', async () => {
      await seed('owner', { knauf_content_hash: 'H', knauf_asset_id: 'owner' });
      await seed('reuse', { knauf_content_hash: 'H', knauf_asset_id: 'owner' });
      const found = await findAssetForHash({ user: userId, knauf_content_hash: 'H' });
      expect(found.knauf_asset_id).toBe('owner');
    });

    // Issue 2: even if the embed-owner row is gone, a surviving reuse row still
    // carries the asset id, so the next upload reuses it instead of re-embedding.
    test('still resolves the asset when only a reuse row survives (owner gone)', async () => {
      await seed('reuse', { knauf_content_hash: 'H', knauf_asset_id: 'gone-owner' });
      const found = await findAssetForHash({ user: userId, knauf_content_hash: 'H' });
      expect(found.knauf_asset_id).toBe('gone-owner');
    });

    test('ignores legacy/non-deduped rows that carry no knauf_asset_id', async () => {
      await seed('legacy', { knauf_content_hash: 'H' }); // no asset id
      await expect(findAssetForHash({ user: userId, knauf_content_hash: 'H' })).resolves.toBeNull();
    });

    // The DB-side `knauf_asset_id: { $exists: true }` filter is the only thing
    // excluding no-asset rows now (the JS post-filter was removed), so a legacy row —
    // even an OLDER one — must never be returned in preference to the real asset row.
    test('ignores an older legacy row and resolves the asset row in a mixed group', async () => {
      await seed('legacy-old', { knauf_content_hash: 'H' }); // no asset id, older
      await seed('asset-new', { knauf_content_hash: 'H', knauf_asset_id: 'asset-new' });
      await File.updateOne(
        { file_id: 'legacy-old' },
        { $set: { createdAt: new Date('2019-01-01') } },
      );
      await File.updateOne(
        { file_id: 'asset-new' },
        { $set: { createdAt: new Date('2022-01-01') } },
      );
      const found = await findAssetForHash({ user: userId, knauf_content_hash: 'H' });
      expect(found.file_id).toBe('asset-new');
      expect(found.knauf_asset_id).toBe('asset-new');
    });

    test('returns the oldest row deterministically when several share the asset', async () => {
      await seed('old', { knauf_content_hash: 'H', knauf_asset_id: 'old' });
      await seed('new', { knauf_content_hash: 'H', knauf_asset_id: 'old' });
      // timestamps:true sets createdAt on insert; override on update to make order deterministic.
      await File.updateOne({ file_id: 'old' }, { $set: { createdAt: new Date('2020-01-01') } });
      await File.updateOne({ file_id: 'new' }, { $set: { createdAt: new Date('2021-01-01') } });
      const found = await findAssetForHash({ user: userId, knauf_content_hash: 'H' });
      expect(found.file_id).toBe('old');
    });
  });
});
// End [knauf]
