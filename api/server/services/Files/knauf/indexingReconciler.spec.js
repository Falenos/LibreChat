// [knauf] KK20-195 WP4b — seam test for the §8.4 reconciliation loop: one
// test per case, asserting the repair-vs-alert split (repairs only
// unambiguous safe actions; everything else alerts and leaves state intact).
// Runs the REAL FileAsset methods + File model on mongodb-memory-server.
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { fileSchema, fileAssetSchema, createFileAssetMethods } = require('@librechat/data-schemas');
const { createIndexingReconciler } = require('./indexingReconciler');

let mongoServer;
let KnaufFileAsset;
let File;
let db;

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const cleanupAsset = jest.fn().mockResolvedValue(true);

const listAssets = (filter, limit, sort = { updatedAt: 1 }) =>
  KnaufFileAsset.find(filter).sort(sort).limit(limit).lean();
const listFileAssetRefs = (limit) =>
  File.find({ knauf_asset_id: { $exists: true, $ne: null } })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .select({ file_id: 1, knauf_asset_id: 1 })
    .lean();

const buildReconciler = () =>
  createIndexingReconciler({ db, listAssets, listFileAssetRefs, cleanupAsset, logger });

const alerts = () => logger.error.mock.calls.map(([msg]) => msg);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  KnaufFileAsset =
    mongoose.models.KnaufFileAsset || mongoose.model('KnaufFileAsset', fileAssetSchema);
  File = mongoose.models.File || mongoose.model('File', fileSchema);
  db = {
    ...createFileAssetMethods(mongoose),
    getFiles: async (filter, _sort, select) => File.find(filter, select).lean(),
    getAssetsByAssetIds: async (ids) => KnaufFileAsset.find({ asset_id: { $in: ids } }).lean(),
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
  cleanupAsset.mockResolvedValue(true);
});

const LONG_AGO = new Date(Date.now() - 48 * 60 * 60 * 1000);

/** Seed an asset and force `updatedAt` back so cutoff-based cases see it. */
const seedAsset = async (overrides = {}) => {
  const doc = await KnaufFileAsset.create({
    asset_id: overrides.asset_id ?? 'a1',
    scope_type: 'user',
    scope_id: 'u1',
    target_index_profile: 'legacy-v0',
    vector_backend: 'pgvector',
    embed_route: '/embed',
    status: 'queued',
    blob: { source: 'local', path: '/blob/a', bytes: 10 },
    ...overrides,
  });
  if (overrides.aged !== false) {
    await KnaufFileAsset.collection.updateMany(
      { asset_id: doc.asset_id },
      { $set: { updatedAt: LONG_AGO } },
    );
  }
  return doc;
};

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

describe('case 1 — stale uploading', () => {
  test('unreferenced dead reservation is cleaned and removed', async () => {
    await seedAsset({ asset_id: 'u-stale', status: 'uploading' });
    const counts = await buildReconciler().runOnce();
    expect(counts.stale_uploading).toMatchObject({ scanned: 1, repaired: 1, alerted: 0 });
    expect(await db.getAssetByAssetId('u-stale')).toBeNull();
  });

  test('a REFERENCED uploading asset is never auto-deleted — alert only', async () => {
    await seedAsset({ asset_id: 'u-ref', status: 'uploading' });
    await seedFile({ file_id: 'fr', knauf_asset_id: 'u-ref' });
    const counts = await buildReconciler().runOnce();
    expect(counts.stale_uploading).toMatchObject({ repaired: 0, alerted: 1 });
    expect(await db.getAssetByAssetId('u-ref')).not.toBeNull();
    expect(alerts().some((m) => m.includes('stale_uploading_referenced'))).toBe(true);
  });

  test('a FRESH uploading asset is out of scope', async () => {
    await seedAsset({ asset_id: 'u-fresh', status: 'uploading', aged: false });
    const counts = await buildReconciler().runOnce();
    expect(counts.stale_uploading.scanned).toBe(0);
  });
});

describe('case 2 — long-expired processing lease', () => {
  test('alerts (worker fleet not draining) but repairs nothing — §5.1 owns reclaim', async () => {
    await seedAsset({
      asset_id: 'lease-1',
      status: 'processing',
      lease_owner: 'w-dead',
      lease_expires_at: LONG_AGO,
      execution_token: 'tok',
    });
    const counts = await buildReconciler().runOnce();
    expect(counts.expired_lease).toMatchObject({ scanned: 1, repaired: 0, alerted: 1 });
    expect((await db.getAssetByAssetId('lease-1')).status).toBe('processing'); // untouched
    expect(alerts().some((m) => m.includes('expired_lease_not_reclaimed'))).toBe(true);
  });
});

describe('case 3 — File pointing at a missing asset', () => {
  test('dangling pointer alerts; intact pointer does not', async () => {
    await seedAsset({ asset_id: 'exists', status: 'ready', active_generation: 1, aged: false });
    await seedFile({ file_id: 'ok', knauf_asset_id: 'exists' });
    await seedFile({ file_id: 'dangling', knauf_asset_id: 'gone' });

    const counts = await buildReconciler().runOnce();

    expect(counts.dangling_file_refs).toMatchObject({ scanned: 2, alerted: 1 });
    expect(alerts().some((m) => m.includes('file_missing_asset') && m.includes('gone'))).toBe(true);
  });
});

describe('case 4 — asset with no logical references', () => {
  test('an old orphan is tombstoned, cleaned, and removed', async () => {
    await seedAsset({ asset_id: 'orphan', status: 'ready', active_generation: 1 });
    const counts = await buildReconciler().runOnce();
    expect(counts.orphan_assets).toMatchObject({ repaired: 1, alerted: 0 });
    expect(cleanupAsset).toHaveBeenCalledWith(expect.objectContaining({ asset_id: 'orphan' }));
    expect(await db.getAssetByAssetId('orphan')).toBeNull();
  });

  test('a referenced asset is kept', async () => {
    await seedAsset({ asset_id: 'held', status: 'ready', active_generation: 1 });
    await seedFile({ file_id: 'holder', knauf_asset_id: 'held' });
    const counts = await buildReconciler().runOnce();
    expect(counts.orphan_assets).toMatchObject({ repaired: 0, kept: 1 });
    expect(await db.getAssetByAssetId('held')).not.toBeNull();
  });

  test('failed cleanup leaves delete_failed (retryable), not removed', async () => {
    await seedAsset({ asset_id: 'orphan-bad', status: 'ready', active_generation: 1 });
    cleanupAsset.mockResolvedValue(false);
    const counts = await buildReconciler().runOnce();
    expect(counts.orphan_assets).toMatchObject({ repaired: 0, alerted: 1 });
    expect((await db.getAssetByAssetId('orphan-bad')).status).toBe('delete_failed');
  });

  test('rotating cursor reaches an orphan behind kept (referenced) assets (KK20-195 review)', async () => {
    // Without the cursor, referenced assets keep their updatedAt and freeze the
    // oldest-N window forever, so orphans behind them are never reached.
    process.env.KNAUF_RECONCILE_BATCH_LIMIT = '2';
    try {
      // Two referenced assets (kept, never removed) at the front by _id…
      await seedAsset({ asset_id: 'kept-1', status: 'ready', active_generation: 1 });
      await seedAsset({ asset_id: 'kept-2', status: 'ready', active_generation: 1 });
      // …and one orphan behind them.
      await seedAsset({ asset_id: 'orphan-behind', status: 'ready', active_generation: 1 });
      await seedFile({ file_id: 'fk1', knauf_asset_id: 'kept-1' });
      await seedFile({ file_id: 'fk2', knauf_asset_id: 'kept-2' });

      const reconciler = buildReconciler(); // one instance → the cursor persists across passes
      const first = await reconciler.runOnce();
      expect(first.orphan_assets).toMatchObject({ kept: 2, repaired: 0 });
      expect(await db.getAssetByAssetId('orphan-behind')).not.toBeNull();

      const second = await reconciler.runOnce();
      expect(second.orphan_assets).toMatchObject({ repaired: 1 });
      expect(await db.getAssetByAssetId('orphan-behind')).toBeNull();
    } finally {
      delete process.env.KNAUF_RECONCILE_BATCH_LIMIT;
    }
  });
});

describe('case 5 — delete_failed due for retry', () => {
  test('successful retry finishes the deletion', async () => {
    await seedAsset({
      asset_id: 'df-1',
      status: 'delete_failed',
      delete_requested_at: LONG_AGO,
      last_error_code: 'physical_cleanup_failed',
    });
    const counts = await buildReconciler().runOnce();
    expect(counts.delete_failed).toMatchObject({ repaired: 1, alerted: 0 });
    expect(await db.getAssetByAssetId('df-1')).toBeNull();
  });

  test('another failure returns it to delete_failed and alerts', async () => {
    await seedAsset({
      asset_id: 'df-2',
      status: 'delete_failed',
      delete_requested_at: LONG_AGO,
      last_error_code: 'physical_cleanup_failed',
    });
    cleanupAsset.mockResolvedValue(false);
    const counts = await buildReconciler().runOnce();
    expect(counts.delete_failed).toMatchObject({ repaired: 0, alerted: 1 });
    expect((await db.getAssetByAssetId('df-2')).status).toBe('delete_failed');
    expect(alerts().some((m) => m.includes('delete_retry_failed'))).toBe(true);
  });
});

describe('case 6 — ready without an active generation', () => {
  test('alert only; state intact (corruption is a human problem)', async () => {
    await seedAsset({ asset_id: 'weird', status: 'ready', active_generation: null, aged: false });
    const counts = await buildReconciler().runOnce();
    expect(counts.ready_without_generation).toMatchObject({ scanned: 1, alerted: 1 });
    expect((await db.getAssetByAssetId('weird')).status).toBe('ready');
    expect(alerts().some((m) => m.includes('ready_without_generation'))).toBe(true);
  });
});

describe('case 7 — migration inconsistency', () => {
  test('counts and alerts, never repairs', async () => {
    await seedAsset({
      asset_id: 'mig-1',
      status: 'failed',
      last_error_code: 'migration_inconsistent',
      aged: false,
    });
    const counts = await buildReconciler().runOnce();
    expect(counts.migration_inconsistent).toMatchObject({ scanned: 1, alerted: 1 });
    expect((await db.getAssetByAssetId('mig-1')).status).toBe('failed');
  });
});

describe('containment', () => {
  test('one failing case cannot stall the rest of the pass', async () => {
    await seedAsset({
      asset_id: 'mig-2',
      status: 'failed',
      last_error_code: 'migration_inconsistent',
      aged: false,
    });
    const broken = createIndexingReconciler({
      db,
      listAssets: (filter, limit) => {
        if (filter.status === 'uploading') {
          throw new Error('index missing');
        }
        return listAssets(filter, limit);
      },
      listFileAssetRefs,
      cleanupAsset,
      logger,
    });
    const counts = await broken.runOnce();
    expect(counts.stale_uploading).toEqual({ error: 'index missing' });
    expect(counts.migration_inconsistent).toMatchObject({ scanned: 1 });
  });
});
// End [knauf]
