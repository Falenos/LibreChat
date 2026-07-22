// [knauf] KK20-195 WP4b — seam test for the §8.4 reconciliation loop: one
// test per case, asserting the repair-vs-alert split (repairs only
// unambiguous safe actions; everything else alerts and leaves state intact).
// Runs the REAL FileAsset methods + File model on mongodb-memory-server.
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { fileSchema, fileAssetSchema, createFileAssetMethods } = require('@librechat/data-schemas');
const { createIndexingReconciler, createMongoReconcilerLease } = require('./indexingReconciler');

let mongoServer;
let KnaufFileAsset;
let File;
let db;

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const cleanupAsset = jest.fn().mockResolvedValue(true);

const listAssets = (filter, limit, sort = { updatedAt: 1 }) =>
  KnaufFileAsset.find(filter).sort(sort).limit(limit).lean();
// KK20-195 review F7 — mirrors worker.js: full indexed count for alert-only cases.
const countAssets = (filter) => KnaufFileAsset.countDocuments(filter);
// KK20-195 review R8 — mirrors worker.js: rotating _id cursor (afterId).
const listFileAssetRefs = (limit, afterId = null) =>
  File.find({
    knauf_asset_id: { $exists: true, $ne: null },
    ...(afterId != null ? { _id: { $gt: afterId } } : {}),
  })
    .sort({ _id: 1 })
    .limit(limit)
    .select({ file_id: 1, knauf_asset_id: 1, knauf_upload_finalized: 1 })
    .lean();

// KK20-195 review R9 — the debt-drain case deletes single generations.
const deleteGenerationMock = jest.fn().mockResolvedValue(undefined);

const buildReconciler = (overrides = {}) =>
  createIndexingReconciler({
    db,
    listAssets,
    countAssets,
    listFileAssetRefs,
    cleanupAsset,
    deleteGeneration: deleteGenerationMock,
    logger,
    ...overrides,
  });

const alerts = () => logger.error.mock.calls.map(([msg]) => msg);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  KnaufFileAsset =
    mongoose.models.KnaufFileAsset || mongoose.model('KnaufFileAsset', fileAssetSchema);
  File = mongoose.models.File || mongoose.model('File', fileSchema);
  db = {
    ...createFileAssetMethods(mongoose),
    getFiles: async (filter, _sort, select) => File.find(filter, select).lean(),
    deleteFiles: async (fileIds) => File.deleteMany({ file_id: { $in: fileIds } }),
    removeAgentResourceFilesFromAllAgents: jest.fn().mockResolvedValue(undefined),
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
  await mongoose.connection.db.collection('knauf_file_indexing_locks_test').deleteMany({});
  jest.clearAllMocks();
  cleanupAsset.mockResolvedValue(true);
  deleteGenerationMock.mockReset().mockResolvedValue(undefined);
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

  test('a referenced upload with durable blob intent resumes at queued', async () => {
    await seedAsset({ asset_id: 'u-ref', status: 'uploading' });
    await seedFile({ file_id: 'fr', knauf_asset_id: 'u-ref' });
    const counts = await buildReconciler().runOnce();
    expect(counts.stale_uploading).toMatchObject({ repaired: 1, alerted: 0 });
    const asset = await db.getAssetByAssetId('u-ref');
    expect(asset.status).toBe('queued');
    expect(asset.blob).toMatchObject({ path: '/blob/a', filename: 'doc.pdf' });
  });

  test('a referenced upload without blob intent fails visibly for re-upload', async () => {
    await seedAsset({ asset_id: 'u-no-blob', status: 'uploading' });
    await seedFile({ file_id: 'fr-no-blob', knauf_asset_id: 'u-no-blob' });
    await File.collection.updateOne({ file_id: 'fr-no-blob' }, { $unset: { filepath: '' } });
    const counts = await buildReconciler().runOnce();
    expect(counts.stale_uploading).toMatchObject({ repaired: 1, alerted: 1 });
    const asset = await db.getAssetByAssetId('u-no-blob');
    expect(asset.status).toBe('failed');
    expect(asset.last_error_code).toBe('upload_interrupted_reupload_required');
    expect(alerts().some((m) => m.includes('stale_uploading_reupload_required'))).toBe(true);
  });

  test('a lost stale-upload transition does not emit a false re-upload alert', async () => {
    await seedAsset({ asset_id: 'u-raced', status: 'uploading' });
    await seedFile({ file_id: 'fr-raced', knauf_asset_id: 'u-raced' });
    await File.collection.updateOne({ file_id: 'fr-raced' }, { $unset: { filepath: '' } });
    const failStaleUpload = jest.spyOn(db, 'failStaleUpload').mockResolvedValueOnce(null);

    const counts = await buildReconciler().runOnce();

    expect(counts.stale_uploading).toMatchObject({ repaired: 0, alerted: 1 });
    expect(alerts().some((m) => m.includes('stale_uploading_transition_lost'))).toBe(true);
    expect(alerts().some((m) => m.includes('stale_uploading_reupload_required'))).toBe(false);
    failStaleUpload.mockRestore();
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

  test('unfinished finalization pointing at a missing asset is removed', async () => {
    await seedFile({
      file_id: 'pending-dangling',
      knauf_asset_id: 'already-deleted',
      knauf_upload_finalized: false,
    });

    const counts = await buildReconciler().runOnce();

    expect(counts.dangling_file_refs).toMatchObject({ scanned: 1, repaired: 1, alerted: 0 });
    expect(await File.findOne({ file_id: 'pending-dangling' })).toBeNull();
    expect(db.removeAgentResourceFilesFromAllAgents).toHaveBeenCalledWith({
      file_ids: ['pending-dangling'],
    });
  });

  test('a dangling-ref backlog emits one bounded summary while preserving the affected count', async () => {
    for (let index = 1; index <= 12; index += 1) {
      await seedFile({ file_id: `dangling-${index}`, knauf_asset_id: `gone-${index}` });
    }

    const counts = await buildReconciler().runOnce();
    const missingAssetAlerts = alerts().filter((message) => message.includes('file_missing_asset'));

    expect(counts.dangling_file_refs).toMatchObject({ scanned: 12, alerted: 12 });
    expect(missingAssetAlerts).toHaveLength(1);
    expect(missingAssetAlerts[0]).toContain('12 finalized file(s)');
    expect(missingAssetAlerts[0]).toContain('dangling-1');
    expect(missingAssetAlerts[0]).not.toContain('dangling-12');
  });
});

describe('fleet-wide reconciler lease', () => {
  const collection = () => mongoose.connection.db.collection('knauf_file_indexing_locks_test');
  const at = (iso) => () => new Date(iso);

  test('only one of five worker replicas acquires a fresh lease', async () => {
    const acquire = Array.from({ length: 5 }, (_, index) =>
      createMongoReconcilerLease({
        collection: collection(),
        ownerId: `worker-${index}`,
        leaseMs: 60_000,
        now: at('2026-07-21T12:00:00.000Z'),
      }),
    );

    const outcomes = await Promise.all(acquire.map((tryAcquire) => tryAcquire()));

    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  test('another worker takes over only after the lease expires', async () => {
    const first = createMongoReconcilerLease({
      collection: collection(),
      ownerId: 'worker-a',
      leaseMs: 60_000,
      now: at('2026-07-21T12:00:00.000Z'),
    });
    const tooEarly = createMongoReconcilerLease({
      collection: collection(),
      ownerId: 'worker-b',
      leaseMs: 60_000,
      now: at('2026-07-21T12:00:59.999Z'),
    });
    const afterExpiry = createMongoReconcilerLease({
      collection: collection(),
      ownerId: 'worker-b',
      leaseMs: 60_000,
      now: at('2026-07-21T12:01:00.001Z'),
    });

    await expect(first()).resolves.toBe(true);
    await expect(tooEarly()).resolves.toBe(false);
    await expect(afterExpiry()).resolves.toBe(true);
  });

  test('a replica without the lease skips the pass', async () => {
    const acquireRunLease = jest.fn().mockResolvedValue(false);

    await expect(buildReconciler({ acquireRunLease }).runOnce()).resolves.toBeNull();
    expect(acquireRunLease).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('pass complete'));
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

// KK20-195 review R9 — case 8: cleanup debt is drained, one generation at a
// time; a confirmed delete pulls its entry, a still-failing one alerts and
// STAYS recorded.
describe('case 8 — stale-generation cleanup debt (R9)', () => {
  test('confirmed deletes pull their debt; failing ones alert and stay', async () => {
    await seedAsset({
      asset_id: 'debt-a',
      status: 'ready',
      active_generation: 3,
      stale_generations: [1, 2],
      aged: false,
    });
    await seedFile({ file_id: 'ref-a', knauf_asset_id: 'debt-a' }); // keeps case 4 away
    deleteGenerationMock.mockImplementation(async (_asset, generation) => {
      if (generation === 2) {
        throw new Error('rag still down');
      }
    });

    const counts = await buildReconciler().runOnce();

    expect(counts.stale_generations).toMatchObject({ scanned: 1, repaired: 1, alerted: 1 });
    const asset = await db.getAssetByAssetId('debt-a');
    expect(asset.stale_generations).toEqual([2]); // unpaid debt survives
    expect(alerts().some((m) => m.includes('cleanup_debt_unpaid'))).toBe(true);
  });

  test('debt-free assets are never scanned', async () => {
    await seedAsset({ asset_id: 'clean-a', status: 'ready', active_generation: 1, aged: false });
    const counts = await buildReconciler().runOnce();
    expect(counts.stale_generations).toMatchObject({ scanned: 0 });
    expect(deleteGenerationMock).not.toHaveBeenCalled();
  });
});

// KK20-195 review R8 — every bounded case converges: rows a pass leaves in
// place or are repaired must not freeze the window and starve the
// rows behind them. Datasets deliberately exceed the batch limit.
describe('R8 — rotating cursors converge for cases 1, 3, and 5', () => {
  beforeEach(() => {
    process.env.KNAUF_RECONCILE_BATCH_LIMIT = '2';
  });
  afterEach(() => {
    delete process.env.KNAUF_RECONCILE_BATCH_LIMIT;
  });

  test('case 1: a dead reservation behind two REFERENCED stale-uploading assets is reached', async () => {
    await seedAsset({ asset_id: 'su-1', status: 'uploading' });
    await seedAsset({ asset_id: 'su-2', status: 'uploading' });
    await seedAsset({ asset_id: 'su-behind', status: 'uploading' });
    await seedFile({ file_id: 'r1', knauf_asset_id: 'su-1' });
    await seedFile({ file_id: 'r2', knauf_asset_id: 'su-2' });

    const reconciler = buildReconciler();
    const first = await reconciler.runOnce();
    expect(first.stale_uploading).toMatchObject({ alerted: 0, repaired: 2 });
    expect(await db.getAssetByAssetId('su-behind')).not.toBeNull();

    const second = await reconciler.runOnce();
    expect(second.stale_uploading).toMatchObject({ repaired: 1 });
    expect(await db.getAssetByAssetId('su-behind')).toBeNull();
  });

  test('case 3: a dangling ref behind two intact refs is reached (alert-only case)', async () => {
    await seedAsset({ asset_id: 'ok-1', status: 'ready', active_generation: 1, aged: false });
    await seedFile({ file_id: 'ref-1', knauf_asset_id: 'ok-1' });
    await seedFile({ file_id: 'ref-2', knauf_asset_id: 'ok-1' });
    await seedFile({ file_id: 'ref-dangling', knauf_asset_id: 'gone-asset' });

    const reconciler = buildReconciler();
    const first = await reconciler.runOnce();
    expect(first.dangling_file_refs).toMatchObject({ scanned: 2, alerted: 0 });

    const second = await reconciler.runOnce();
    expect(second.dangling_file_refs).toMatchObject({ alerted: 1 });
    expect(alerts().some((m) => m.includes('gone-asset'))).toBe(true);
  });

  test('case 5: a finishable deletion behind two referenced tombstones is reached', async () => {
    await seedAsset({ asset_id: 'ts-1', status: 'deleting', delete_requested_at: LONG_AGO });
    await seedAsset({ asset_id: 'ts-2', status: 'deleting', delete_requested_at: LONG_AGO });
    await seedAsset({
      asset_id: 'ts-behind',
      status: 'delete_failed',
      delete_requested_at: LONG_AGO,
    });
    await seedFile({ file_id: 't1', knauf_asset_id: 'ts-1' });
    await seedFile({ file_id: 't2', knauf_asset_id: 'ts-2' });

    const reconciler = buildReconciler();
    const first = await reconciler.runOnce();
    expect(first.delete_failed).toMatchObject({ alerted: 0, repaired: 2 });
    expect(await db.getAssetByAssetId('ts-behind')).not.toBeNull();

    const second = await reconciler.runOnce();
    expect(second.delete_failed).toMatchObject({ repaired: 1 });
    expect(await db.getAssetByAssetId('ts-behind')).toBeNull();
  });
});

// KK20-195 review F7 (re-review) — the alert-only cases 2, 6, 7 previously read
// only the first page (no cursor): records beyond batchLimit were never observed
// and counts were truncated. They now report a COMPLETE count (restart-safe,
// stateless) and rotate a bounded detail sample.
describe('F7 — alert-only cases: complete counts + detail convergence + restart-safety', () => {
  beforeEach(() => {
    process.env.KNAUF_RECONCILE_BATCH_LIMIT = '2';
  });
  afterEach(() => {
    delete process.env.KNAUF_RECONCILE_BATCH_LIMIT;
  });

  test('case 2: reports the FULL count over batchLimit and the detail reaches the tail', async () => {
    for (const n of [1, 2, 3]) {
      await seedAsset({ asset_id: `el-${n}`, status: 'processing', lease_expires_at: LONG_AGO });
    }
    const reconciler = buildReconciler();
    const first = await reconciler.runOnce();
    // total is the FULL count (3), not the batchLimit page (2) — the finding.
    expect(first.expired_lease).toMatchObject({ total: 3, alerted: 3, scanned: 2 });
    expect(alerts().some((m) => m.includes('3 processing asset(s)'))).toBe(true);

    await reconciler.runOnce(); // rotate to the next page
    expect(alerts().some((m) => m.includes('el-3'))).toBe(true); // record behind page 1 is reached
  });

  test('case 2: a redeploy (fresh in-memory cursor) still reports the complete count', async () => {
    for (const n of [1, 2, 3]) {
      await seedAsset({ asset_id: `elr-${n}`, status: 'processing', lease_expires_at: LONG_AGO });
    }
    // A brand-new reconciler models a worker restart — the metric is stateless.
    const counts = await buildReconciler().runOnce();
    expect(counts.expired_lease).toMatchObject({ total: 3 });
  });

  test('case 6: ready-without-generation reports the complete count over batchLimit', async () => {
    // aged:false so the orphan sweep (case 4, which requires an aged updatedAt)
    // doesn't consume these before case 6 counts them.
    for (const n of [1, 2, 3]) {
      await seedAsset({
        asset_id: `rg-${n}`,
        status: 'ready',
        active_generation: null,
        aged: false,
      });
    }
    const counts = await buildReconciler().runOnce();
    expect(counts.ready_without_generation).toMatchObject({ total: 3, alerted: 3, scanned: 2 });
    expect(alerts().some((m) => m.includes('3 ready asset(s)'))).toBe(true);
  });

  test('case 7: migration-inconsistent reports the complete count over batchLimit', async () => {
    for (const n of [1, 2, 3]) {
      await seedAsset({
        asset_id: `mi-${n}`,
        status: 'failed',
        last_error_code: 'migration_inconsistent',
        aged: false,
      });
    }
    const counts = await buildReconciler().runOnce();
    expect(counts.migration_inconsistent).toMatchObject({ total: 3, alerted: 3, scanned: 2 });
  });
});

describe('case 5 — delete_failed due for retry', () => {
  // KK20-195 review R4 — the deletion owner is a request that can die
  // mid-delete; stale 'deleting' is swept too, and a tombstoned asset that
  // still has references (interrupted metadata commit) removes those logical
  // rows before retrying the durable physical cleanup.
  test('a stale deleting asset (crashed owner) with no references is finished', async () => {
    await seedAsset({ asset_id: 'dl-1', status: 'deleting', delete_requested_at: LONG_AGO });
    const counts = await buildReconciler().runOnce();
    expect(counts.delete_failed).toMatchObject({ repaired: 1, alerted: 0 });
    expect(await db.getAssetByAssetId('dl-1')).toBeNull();
  });

  test('a tombstoned asset repairs surviving metadata before physical cleanup (R4)', async () => {
    await seedAsset({ asset_id: 'dl-2', status: 'deleting', delete_requested_at: LONG_AGO });
    await seedFile({ file_id: 'still-here', knauf_asset_id: 'dl-2' });

    const counts = await buildReconciler().runOnce();

    expect(counts.delete_failed).toMatchObject({ repaired: 1, alerted: 0 });
    expect(await File.findOne({ file_id: 'still-here' })).toBeNull();
    expect(await db.getAssetByAssetId('dl-2')).toBeNull();
    expect(cleanupAsset).toHaveBeenCalledWith(expect.objectContaining({ asset_id: 'dl-2' }));
  });

  test('a metadata cleanup failure alerts and leaves the tombstone for retry', async () => {
    await seedAsset({ asset_id: 'dl-meta', status: 'deleting', delete_requested_at: LONG_AGO });
    await seedFile({ file_id: 'still-here', knauf_asset_id: 'dl-meta' });
    const deleteSpy = jest.spyOn(db, 'deleteFiles').mockRejectedValueOnce(new Error('mongo down'));

    const counts = await buildReconciler().runOnce();

    expect(counts.delete_failed).toMatchObject({ repaired: 0, alerted: 1 });
    expect(await File.findOne({ file_id: 'still-here' })).not.toBeNull();
    expect(await db.getAssetByAssetId('dl-meta')).not.toBeNull();
    expect(alerts().some((m) => m.includes('tombstoned_metadata_cleanup_failed'))).toBe(true);
    deleteSpy.mockRestore();
  });

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
      countAssets,
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
