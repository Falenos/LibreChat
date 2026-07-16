// [knauf] KK20-195 WP3d — seam test for the delete-surface bridge into the
// FileAsset state machine: §8.1 last-reference recount (shared assets
// survive), §8.2 tombstone-before-cleanup (blocks worker claims mid-delete),
// §8.3 failed cleanup → delete_failed (retryable) and removeAsset only on
// confirmed cleanup. Runs the REAL FileAsset methods + File model on
// mongodb-memory-server.
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { fileSchema, fileAssetSchema, createFileAssetMethods } = require('@librechat/data-schemas');
const { gcAssetThroughLifecycle, finalizeAssetsAfterRowDelete } = require('./fileAssetDelete');

let mongoServer;
let KnaufFileAsset;
let File;
let db;
const logger = { warn: jest.fn() };

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  KnaufFileAsset =
    mongoose.models.KnaufFileAsset || mongoose.model('KnaufFileAsset', fileAssetSchema);
  File = mongoose.models.File || mongoose.model('File', fileSchema);
  db = {
    ...createFileAssetMethods(mongoose),
    getFiles: async (filter, _sort, select) => File.find(filter, select).lean(),
  };
  await mongoose.connect(mongoServer.getUri());
  await KnaufFileAsset.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await KnaufFileAsset.deleteMany({});
  await File.deleteMany({});
  jest.clearAllMocks();
});

const seedAsset = (overrides = {}) =>
  KnaufFileAsset.create({
    asset_id: overrides.asset_id ?? 'a1',
    scope_type: 'user',
    scope_id: 'u1',
    target_index_profile: 'legacy-v0',
    vector_backend: 'pgvector',
    embed_route: '/embed',
    status: 'queued',
    blob: { source: 'local', path: '/blob/a', bytes: 10 },
    queued_at: new Date(),
    next_attempt_at: new Date(0),
    ...overrides,
  });

const seedFile = (overrides = {}) =>
  File.create({
    user: new mongoose.Types.ObjectId(),
    file_id: overrides.file_id ?? 'f1',
    filename: 'doc.pdf',
    filepath: '/blob/a',
    object: 'file',
    type: 'application/pdf',
    bytes: 10,
    ...overrides,
  });

describe('gcAssetThroughLifecycle (§8.2/§8.3)', () => {
  test('tombstone lands BEFORE cleanup and blocks worker claims mid-delete', async () => {
    await seedAsset({ asset_id: 'g1' });
    let claimDuringCleanup = 'unset';
    const ok = await gcAssetThroughLifecycle({
      db,
      asset_id: 'g1',
      logger,
      cleanup: async () => {
        claimDuringCleanup = await db.claimNextDue({ workerId: 'w1', leaseMs: 60_000 });
        return true;
      },
    });
    expect(ok).toBe(true);
    expect(claimDuringCleanup).toBeNull(); // tombstone excluded it from the claim query
    expect(await db.getAssetByAssetId('g1')).toBeNull(); // removed after confirmed cleanup
  });

  test('failed cleanup → delete_failed (retryable), asset row retained', async () => {
    await seedAsset({ asset_id: 'g2' });
    const ok = await gcAssetThroughLifecycle({
      db,
      asset_id: 'g2',
      logger,
      cleanup: async () => false,
    });
    expect(ok).toBe(false);
    const asset = await db.getAssetByAssetId('g2');
    expect(asset.status).toBe('delete_failed');
    expect(asset.last_error_code).toBe('physical_cleanup_failed');
    // §8.3: the record stays retryable — retryDelete resumes the deletion.
    expect(await db.retryDelete({ asset_id: 'g2' })).toBe(true);
    expect((await db.getAssetByAssetId('g2')).status).toBe('deleting');
  });

  test('legacy asset without a ledger row: cleanup still runs, nothing recorded', async () => {
    const cleanup = jest.fn().mockResolvedValue(true);
    const ok = await gcAssetThroughLifecycle({ db, asset_id: 'ghost', logger, cleanup });
    expect(ok).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(await db.getAssetByAssetId('ghost')).toBeNull();
  });
});

describe('finalizeAssetsAfterRowDelete (§8.1)', () => {
  test('surviving reference → shared asset untouched', async () => {
    await seedAsset({ asset_id: 's1', status: 'ready', active_generation: 1 });
    await seedFile({ file_id: 'survivor', knauf_asset_id: 's1' });

    await finalizeAssetsAfterRowDelete({
      db,
      deletedFiles: [{ file_id: 'gone', knauf_asset_id: 's1' }],
      logger,
    });

    const asset = await db.getAssetByAssetId('s1');
    expect(asset.status).toBe('ready');
    expect(asset.delete_requested_at ?? null).toBeNull();
  });

  test('last reference gone → tombstoned and removed', async () => {
    await seedAsset({ asset_id: 's2', status: 'ready', active_generation: 1 });

    await finalizeAssetsAfterRowDelete({
      db,
      deletedFiles: [{ file_id: 'gone', knauf_asset_id: 's2' }],
      logger,
    });

    expect(await db.getAssetByAssetId('s2')).toBeNull();
  });

  test('deduped rows sharing one asset are finalized once; legacy rows are skipped', async () => {
    await seedAsset({ asset_id: 's3', status: 'ready', active_generation: 1 });

    await finalizeAssetsAfterRowDelete({
      db,
      deletedFiles: [
        { file_id: 'r1', knauf_asset_id: 's3' },
        { file_id: 'r2', knauf_asset_id: 's3' }, // same asset, second reuse row
        { file_id: 'legacy' }, // no pointer — pre-FileAsset row
      ],
      logger,
    });

    expect(await db.getAssetByAssetId('s3')).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a store failure is contained (never throws into the delete response)', async () => {
    const brokenDb = {
      ...db,
      getFiles: async () => {
        throw new Error('mongo down');
      },
    };
    await expect(
      finalizeAssetsAfterRowDelete({
        db: brokenDb,
        deletedFiles: [{ file_id: 'x', knauf_asset_id: 'any' }],
        logger,
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
// End [knauf]
