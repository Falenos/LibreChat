// [knauf] KK20-195 WP3d — seam test for the delete-surface bridge into the
// FileAsset state machine: §8.1 last-reference recount (shared assets
// survive), §8.2 tombstone-before-cleanup (blocks worker claims mid-delete),
// §8.3 failed cleanup → delete_failed (retryable) and removeAsset only on
// confirmed cleanup. Runs the REAL FileAsset methods + File model on
// mongodb-memory-server.
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { fileSchema, fileAssetSchema, createFileAssetMethods } = require('@librechat/data-schemas');
const {
  gcAssetThroughLifecycle,
  preTombstoneLastReferences,
  finalizeAssetsAfterRowDelete,
  tombstoneRetainedOrphansAfterRowDelete,
} = require('./fileAssetDelete');

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

  // KK20-195 review R4 — null and an exception are DIFFERENT outcomes.
  test('a tombstone STORE ERROR aborts cleanup (state unknown — never delete blind)', async () => {
    await seedAsset({ asset_id: 'g4' });
    const cleanup = jest.fn().mockResolvedValue(true);
    const brokenDb = {
      ...db,
      tombstoneForDelete: async () => {
        throw new Error('mongo down');
      },
    };

    const ok = await gcAssetThroughLifecycle({ db: brokenDb, asset_id: 'g4', logger, cleanup });

    expect(ok).toBe(false);
    expect(cleanup).not.toHaveBeenCalled(); // blob/vectors untouched
    expect((await db.getAssetByAssetId('g4')).status).toBe('queued'); // asset intact
  });

  test('tombstone null while the asset still EXISTS aborts (unexpected state)', async () => {
    await seedAsset({ asset_id: 'g5' });
    const cleanup = jest.fn().mockResolvedValue(true);
    const weirdDb = { ...db, tombstoneForDelete: async () => null };

    const ok = await gcAssetThroughLifecycle({ db: weirdDb, asset_id: 'g5', logger, cleanup });

    expect(ok).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });
});

// KK20-195 review R4 — §8.2 for the plain-row path: tombstone BEFORE the
// physical deletes when the delete set holds an asset's last references.
describe('preTombstoneLastReferences (§8.2, review R4)', () => {
  test('an asset fully covered by the delete set is tombstoned before physical work', async () => {
    await seedAsset({ asset_id: 'pre-1', status: 'queued' });
    await seedFile({ file_id: 'only-ref', knauf_asset_id: 'pre-1' });

    const { unfenced, tombstoned } = await preTombstoneLastReferences({
      db,
      files: [{ file_id: 'only-ref', knauf_asset_id: 'pre-1' }],
      logger,
    });

    const asset = await db.getAssetByAssetId('pre-1');
    expect(asset.status).toBe('deleting');
    expect(asset.delete_requested_at).not.toBeNull();
    expect(unfenced.size).toBe(0); // fenced cleanly → nothing to skip
    expect(tombstoned.get('pre-1')).toEqual(expect.objectContaining({ status: 'deleting' }));
    // Tombstone blocks the claim path mid-delete.
    expect(await db.claimNextDue({ workerId: 'w1', leaseMs: 60_000 })).toBeNull();
  });

  test('an asset with a reference OUTSIDE the delete set stays live', async () => {
    await seedAsset({ asset_id: 'pre-2', status: 'ready', active_generation: 1 });
    await seedFile({ file_id: 'deleting-ref', knauf_asset_id: 'pre-2' });
    await seedFile({ file_id: 'outside-ref', knauf_asset_id: 'pre-2' });

    const { unfenced, retained } = await preTombstoneLastReferences({
      db,
      files: [{ file_id: 'deleting-ref', knauf_asset_id: 'pre-2' }],
      logger,
    });

    const asset = await db.getAssetByAssetId('pre-2');
    expect(asset.status).toBe('ready');
    expect(asset.delete_requested_at ?? null).toBeNull();
    expect(unfenced.has('pre-2')).toBe(false); // a live survivor is NOT a fence failure
    expect(retained.has('pre-2')).toBe(true); // caller deletes only its logical row
  });

  test('a pre-ledger asset id is classified for legacy physical cleanup', async () => {
    await seedFile({ file_id: 'legacy-ref', knauf_asset_id: 'legacy-asset' });

    const { legacy, tombstoned } = await preTombstoneLastReferences({
      db,
      files: [{ file_id: 'legacy-ref', knauf_asset_id: 'legacy-asset' }],
      logger,
    });

    expect(legacy.has('legacy-asset')).toBe(true);
    expect(tombstoned.has('legacy-asset')).toBe(false);
  });

  // KK20-195 review F5 (re-review) — the tombstone is the deletion fence, so a
  // store error must be PROPAGATED (so the caller skips physical delete), never
  // swallowed as best-effort.
  test('a survivor-read failure marks the asset unfenced (never swallowed)', async () => {
    const brokenDb = {
      ...db,
      getFiles: async () => {
        throw new Error('mongo down');
      },
    };
    const { unfenced } = await preTombstoneLastReferences({
      db: brokenDb,
      files: [{ file_id: 'x', knauf_asset_id: 'any' }],
      logger,
    });
    expect(unfenced.has('any')).toBe(true); // caller will skip physical deletion
    expect(logger.warn).toHaveBeenCalled();
  });

  test('a tombstone-write failure marks the asset unfenced (fence not established)', async () => {
    await seedFile({ file_id: 'lone', knauf_asset_id: 'pre-fail' });
    const brokenDb = {
      ...db,
      tombstoneForDelete: async () => {
        throw new Error('tombstone write failed');
      },
    };
    const { unfenced } = await preTombstoneLastReferences({
      db: brokenDb,
      files: [{ file_id: 'lone', knauf_asset_id: 'pre-fail' }],
      logger,
    });
    expect(unfenced.has('pre-fail')).toBe(true);
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

describe('tombstoneRetainedOrphansAfterRowDelete', () => {
  test('fences an asset when concurrent retained-reference deletes remove the final rows', async () => {
    await seedAsset({ asset_id: 'retained-race', status: 'ready', active_generation: 1 });

    await tombstoneRetainedOrphansAfterRowDelete({
      db,
      deletedFiles: [{ file_id: 'gone', knauf_asset_id: 'retained-race' }],
      retainedAssetIds: new Set(['retained-race']),
      logger,
    });

    const asset = await db.getAssetByAssetId('retained-race');
    expect(asset.status).toBe('deleting');
    expect(asset.delete_requested_at).not.toBeNull();
  });

  test('keeps a retained asset live while another logical row still exists', async () => {
    await seedAsset({ asset_id: 'still-retained', status: 'ready', active_generation: 1 });
    await seedFile({ file_id: 'survivor', knauf_asset_id: 'still-retained' });

    await tombstoneRetainedOrphansAfterRowDelete({
      db,
      deletedFiles: [{ file_id: 'gone', knauf_asset_id: 'still-retained' }],
      retainedAssetIds: new Set(['still-retained']),
      logger,
    });

    expect((await db.getAssetByAssetId('still-retained')).status).toBe('ready');
  });
});
// End [knauf]
