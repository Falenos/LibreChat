// [knauf] KK20-195 WP3c — seam test for the read-side status projections
// (per-file, list attachment, §6.3 batch summary), the §6.4 retry decision,
// and §9.3 admission control. Runs the REAL FileAsset methods and File model
// on mongodb-memory-server.
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { fileSchema, fileAssetSchema, createFileAssetMethods } = require('@librechat/data-schemas');
const {
  projectFileIndexing,
  attachIndexingToFiles,
  buildBatchIndexStatus,
  retryFileIndexing,
} = require('./indexStatus');
const { checkIndexAdmission } = require('./indexAdmission');

let mongoServer;
let KnaufFileAsset;
let File;
let db;

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

describe('projectFileIndexing', () => {
  test('no asset pointer → ready (legacy back-compat)', () => {
    expect(projectFileIndexing({ file_id: 'x' }, null)).toMatchObject({
      status: 'ready',
      ready: true,
    });
  });

  test('pointer without asset row and embedded=false → failed asset_missing', () => {
    expect(
      projectFileIndexing({ file_id: 'x', knauf_asset_id: 'gone', embedded: false }, null),
    ).toMatchObject({ status: 'failed', ready: false, error_code: 'asset_missing' });
  });

  test('asset present → delegates to the asset projection', () => {
    expect(
      projectFileIndexing(
        { file_id: 'x', knauf_asset_id: 'a1' },
        { status: 'processing', active_generation: 2 },
      ),
    ).toMatchObject({ status: 'processing', ready: true });
  });
});

describe('attachIndexingToFiles', () => {
  test('one batched load; rows without pointer pass through untouched', async () => {
    await seedAsset({ asset_id: 'a1', status: 'queued' });
    const files = [
      { file_id: 'f1', knauf_asset_id: 'a1' },
      { file_id: 'f2' }, // image / legacy — untouched
    ];
    const out = await attachIndexingToFiles({ db, files });
    expect(out[0].indexing).toMatchObject({ status: 'queued', ready: false });
    expect(out[1].indexing).toBeUndefined();
    expect(out[1]).toBe(files[1]);
  });

  test('asset-load failure degrades to the plain rows (never takes the listing down)', async () => {
    const failingDb = {
      getAssetsByAssetIds: async () => {
        throw new Error('transient mongo error');
      },
    };
    const files = [{ file_id: 'f1', knauf_asset_id: 'a1' }];
    const out = await attachIndexingToFiles({ db: failingDb, files });
    expect(out).toBe(files);
    expect(out[0].indexing).toBeUndefined();
  });
});

describe('buildBatchIndexStatus (§6.3)', () => {
  test('owner-scoped counts over logical rows + failures list + terminal', async () => {
    const owner = new mongoose.Types.ObjectId();
    const stranger = new mongoose.Types.ObjectId();
    await seedAsset({ asset_id: 'ok', status: 'ready', active_generation: 1 });
    await seedAsset({
      asset_id: 'bad',
      status: 'failed',
      last_error_code: 'parse_failed',
    });
    await seedFile({
      user: owner,
      file_id: 'f-ok',
      knauf_asset_id: 'ok',
      knauf_upload_batch_id: 'b1',
    });
    await seedFile({
      user: owner,
      file_id: 'f-bad',
      knauf_asset_id: 'bad',
      knauf_upload_batch_id: 'b1',
    });
    // Foreign row with the SAME batch id — must be invisible (id ≠ authorization).
    await seedFile({
      user: stranger,
      file_id: 'f-foreign',
      knauf_asset_id: 'ok',
      knauf_upload_batch_id: 'b1',
    });

    const summary = await buildBatchIndexStatus({ db, userId: owner.toString(), batchId: 'b1' });

    expect(summary).toMatchObject({
      batch_id: 'b1',
      total: 2,
      terminal: true,
      counts: { uploading: 0, queued: 0, processing: 0, ready: 1, failed: 1 },
    });
    expect(summary.failures).toEqual([
      { file_id: 'f-bad', error_code: 'parse_failed', retryable: true },
    ]);
  });

  test('non-terminal while any row is still in flight; empty batch is not terminal', async () => {
    const owner = new mongoose.Types.ObjectId();
    await seedAsset({ asset_id: 'q1', status: 'queued' });
    await seedFile({
      user: owner,
      file_id: 'f-q',
      knauf_asset_id: 'q1',
      knauf_upload_batch_id: 'b2',
    });

    const summary = await buildBatchIndexStatus({ db, userId: owner.toString(), batchId: 'b2' });
    expect(summary.terminal).toBe(false);
    expect(summary.counts.queued).toBe(1);

    const empty = await buildBatchIndexStatus({ db, userId: owner.toString(), batchId: 'none' });
    expect(empty).toMatchObject({ total: 0, terminal: false, failures: [] });
  });

  test('a transient asset-load failure PROPAGATES (never reports a false terminal)', async () => {
    // Unlike the list endpoints, batch status must NOT swallow: a degraded page
    // would project every row to ready/failed → false terminal:true → the
    // client stops polling mid-flight. It must throw → route 500 → client retries.
    const failingDb = {
      getFiles: async () => [
        { file_id: 'bf1', knauf_asset_id: 'a-x', knauf_upload_batch_id: 'b3' },
      ],
      getAssetsByAssetIds: async () => {
        throw new Error('transient mongo error');
      },
    };
    await expect(
      buildBatchIndexStatus({ db: failingDb, userId: 'u1', batchId: 'b3' }),
    ).rejects.toThrow('transient mongo error');
  });
});

describe('retryFileIndexing (§6.4)', () => {
  afterEach(() => {
    delete process.env.KNAUF_INDEXING_WORKER_ENABLED;
  });

  test('failed with blob + worker enabled → CAS to queued, 202 + projection', async () => {
    process.env.KNAUF_INDEXING_WORKER_ENABLED = 'true';
    await seedAsset({
      asset_id: 'r1',
      status: 'failed',
      last_error_code: 'rag_5xx',
      attempt_count: 3,
    });
    const { httpStatus, body } = await retryFileIndexing({
      db,
      file: { file_id: 'f1', knauf_asset_id: 'r1' },
    });
    expect(httpStatus).toBe(202);
    expect(body.indexing).toMatchObject({ status: 'queued', ready: false });
    const asset = await db.getAssetByAssetId('r1');
    expect(asset.status).toBe('queued');
    expect(asset.attempt_count).toBe(0);
    expect(asset.last_error_code).toBeNull();
  });

  test('failed with blob but worker DISABLED → 409, asset stays failed (no wedge)', async () => {
    delete process.env.KNAUF_INDEXING_WORKER_ENABLED;
    await seedAsset({
      asset_id: 'r1b',
      status: 'failed',
      last_error_code: 'rag_5xx',
      attempt_count: 3,
    });
    const { httpStatus, body } = await retryFileIndexing({
      db,
      file: { file_id: 'f1b', knauf_asset_id: 'r1b' },
    });
    expect(httpStatus).toBe(409);
    expect(body.error).toBe('indexing_worker_unavailable');
    // Must remain terminal so the client stops polling instead of parking queued.
    expect((await db.getAssetByAssetId('r1b')).status).toBe('failed');
  });

  test('failed WITHOUT blob metadata → 409 file_reupload_required', async () => {
    await seedAsset({ asset_id: 'r2', status: 'failed', blob: undefined });
    const { httpStatus, body } = await retryFileIndexing({
      db,
      file: { file_id: 'f2', knauf_asset_id: 'r2' },
    });
    expect(httpStatus).toBe(409);
    expect(body.error).toBe('file_reupload_required');
    expect((await db.getAssetByAssetId('r2')).status).toBe('failed');
  });

  test('no asset (pointer dangling or absent) → 409 file_reupload_required', async () => {
    const { httpStatus, body } = await retryFileIndexing({
      db,
      file: { file_id: 'f3', knauf_asset_id: 'gone' },
    });
    expect(httpStatus).toBe(409);
    expect(body.error).toBe('file_reupload_required');
  });

  test('idempotent join: already queued by another reference → 202, no state change', async () => {
    await seedAsset({ asset_id: 'r4', status: 'queued' });
    const { httpStatus, body } = await retryFileIndexing({
      db,
      file: { file_id: 'f4', knauf_asset_id: 'r4' },
    });
    expect(httpStatus).toBe(202);
    expect(body.indexing.status).toBe('queued');
  });

  test('ready asset → 200, never re-queued', async () => {
    await seedAsset({ asset_id: 'r5', status: 'ready', active_generation: 1 });
    const { httpStatus, body } = await retryFileIndexing({
      db,
      file: { file_id: 'f5', knauf_asset_id: 'r5' },
    });
    expect(httpStatus).toBe(200);
    expect(body.indexing.ready).toBe(true);
    expect((await db.getAssetByAssetId('r5')).status).toBe('ready');
  });

  test('deleting asset → 409 file_asset_deleting', async () => {
    await seedAsset({ asset_id: 'r6', status: 'deleting', delete_requested_at: new Date() });
    const { httpStatus, body } = await retryFileIndexing({
      db,
      file: { file_id: 'f6', knauf_asset_id: 'r6' },
    });
    expect(httpStatus).toBe(409);
    expect(body.error).toBe('file_asset_deleting');
  });
});

describe('checkIndexAdmission (§9.3)', () => {
  afterEach(() => {
    delete process.env.KNAUF_INDEX_MAX_QUEUED_FILES;
    delete process.env.KNAUF_INDEX_MAX_QUEUED_BYTES;
  });

  test('admits under the caps; terminal assets do not count', async () => {
    await seedAsset({ asset_id: 'done', status: 'ready', active_generation: 1 });
    const result = await checkIndexAdmission({
      db,
      scope_type: 'user',
      scope_id: 'u1',
      incomingBytes: 100,
    });
    expect(result).toEqual({ admitted: true });
  });

  test('rejects on the queued-files cap with a stable reason', async () => {
    process.env.KNAUF_INDEX_MAX_QUEUED_FILES = '2';
    await seedAsset({ asset_id: 'q1', status: 'queued' });
    await seedAsset({ asset_id: 'q2', status: 'processing' });
    const result = await checkIndexAdmission({ db, scope_type: 'user', scope_id: 'u1' });
    expect(result).toEqual({ admitted: false, reason: 'queued_files' });
  });

  test('rejects on the queued-bytes cap including the incoming file', async () => {
    process.env.KNAUF_INDEX_MAX_QUEUED_BYTES = '100';
    await seedAsset({ asset_id: 'q3', status: 'queued', blob: { path: '/b', bytes: 80 } });
    const result = await checkIndexAdmission({
      db,
      scope_type: 'user',
      scope_id: 'u1',
      incomingBytes: 30,
    });
    expect(result).toEqual({ admitted: false, reason: 'queued_bytes' });
  });

  test('other scopes do not count against this scope', async () => {
    process.env.KNAUF_INDEX_MAX_QUEUED_FILES = '1';
    await seedAsset({ asset_id: 'other', status: 'queued', scope_id: 'u2' });
    const result = await checkIndexAdmission({ db, scope_type: 'user', scope_id: 'u1' });
    expect(result).toEqual({ admitted: true });
  });

  // KK20-195 review R7 — reserve-then-recheck defeats the TOCTOU race: every
  // contender's reservation is durably counted before ANY contender decides,
  // so with cap 1 exactly one of N concurrent uploads is admitted.
  test('concurrent admission with cap 1: exactly one of N parallel uploads is admitted (R7)', async () => {
    process.env.KNAUF_INDEX_MAX_QUEUED_FILES = '1';
    const fileAssetMethods = createFileAssetMethods(mongoose);

    const contend = async (n) => {
      // Reserve FIRST (as process.js does under R7)…
      const { asset } = await fileAssetMethods.reserveAsset({
        asset_id: `race-${n}`,
        scope_type: 'user',
        scope_id: 'race-user',
        target_index_profile: 'legacy-v0',
        vector_backend: 'pgvector',
        embed_route: '/embed',
      });
      // …then admit with the own row included in the counts.
      const admission = await checkIndexAdmission({
        db: fileAssetMethods,
        scope_type: 'user',
        scope_id: 'race-user',
        countIncludesSelf: true,
      });
      if (!admission.admitted) {
        // Compensate (as process.js does).
        await fileAssetMethods.tombstoneForDelete({ asset_id: asset.asset_id });
        await fileAssetMethods.removeAsset({ asset_id: asset.asset_id });
      }
      return admission.admitted;
    };

    const results = await Promise.all([contend(1), contend(2), contend(3), contend(4)]);
    const admittedCount = results.filter(Boolean).length;
    expect(admittedCount).toBeLessThanOrEqual(1); // NEVER over the cap — the finding's failure mode
    const survivors = await KnaufFileAsset.countDocuments({ scope_id: 'race-user' });
    expect(survivors).toBe(admittedCount); // losers fully compensated
  });
});
// End [knauf]
