// [knauf] KK20-195 WP2 — seam test for the FileAsset legacy backfill:
// plan-§4.4 mapping (dedup groups → one asset, agent rows → asset_id=file_id,
// pointer backfill, embedded=true → ready/generation-0/legacy profile,
// incomplete → failed+migration_inconsistent), cursor batching/resume, and
// idempotent re-runs. Covers the plan-§14 row "migration may be interrupted
// and rerun without duplicates".

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { fileSchema, fileAssetSchema } = require('@librechat/data-schemas');
const { migrateFileAssetsBatch } = require('./fileAssetMigration');
const { buildDedupKey } = require('./dedupKey');

let mongoServer;
let File;
let KnaufFileAsset;
let Agent;

const seedFile = (overrides = {}) =>
  File.create({
    user: new mongoose.Types.ObjectId('64a000000000000000000001'),
    file_id: `file-${Math.random().toString(36).slice(2)}`,
    filepath: '/blob/path',
    bytes: 10,
    type: 'application/pdf',
    filename: 'doc.pdf',
    object: 'file',
    usage: 0,
    source: 'azure_blob',
    embedded: true,
    ...overrides,
  });

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  File = mongoose.models.File || mongoose.model('File', fileSchema);
  KnaufFileAsset =
    mongoose.models.KnaufFileAsset || mongoose.model('KnaufFileAsset', fileAssetSchema);
  Agent =
    mongoose.models.Agent ||
    mongoose.model(
      'Agent',
      new mongoose.Schema({ id: String, tool_resources: mongoose.Schema.Types.Mixed }),
    );
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all([File.deleteMany({}), KnaufFileAsset.deleteMany({}), Agent.deleteMany({})]);
});

describe('migrateFileAssetsBatch (KK20-195 WP2)', () => {
  test('a dedup group (owner + reuse rows) becomes ONE ready generation-0 asset', async () => {
    const user = new mongoose.Types.ObjectId('64a000000000000000000001');
    await seedFile({
      user,
      file_id: 'owner-1',
      knauf_asset_id: 'owner-1',
      knauf_content_hash: 'h1',
      knauf_dedup_owner: true,
      context: 'message_attachment',
    });
    await seedFile({
      user,
      file_id: 'reuse-1',
      knauf_asset_id: 'owner-1',
      knauf_content_hash: 'h1',
      context: 'message_attachment',
    });

    const result = await migrateFileAssetsBatch({ mongoose, legacyProfile: 'legacy-v0' });

    expect(result.scanned).toBe(2);
    expect(result.assetsCreated).toBe(1);
    expect(result.skippedExisting).toBe(1);
    const asset = await KnaufFileAsset.findOne({ asset_id: 'owner-1' }).lean();
    expect(asset.status).toBe('ready');
    expect(asset.active_generation).toBe(0);
    expect(asset.active_index_profile).toBe('legacy-v0');
    expect(asset.target_index_profile).toBe('legacy-v0');
    expect(asset.dedup_key).toBe(buildDedupKey({ user: String(user), contentHash: 'h1' }));
  });

  test('preserves distinct assets from a legacy double-embed without duplicating the dedup key', async () => {
    const user = new mongoose.Types.ObjectId('64a000000000000000000001');
    await seedFile({
      user,
      file_id: 'duplicate-a',
      knauf_asset_id: 'duplicate-a',
      knauf_content_hash: 'same-hash',
      context: 'message_attachment',
    });
    await seedFile({
      user,
      file_id: 'duplicate-b',
      knauf_asset_id: 'duplicate-b',
      knauf_content_hash: 'same-hash',
      context: 'message_attachment',
    });

    const result = await migrateFileAssetsBatch({ mongoose, legacyProfile: 'legacy-v0' });

    expect(result.assetsCreated).toBe(2);
    const assets = await KnaufFileAsset.find({}).sort({ asset_id: 1 }).lean();
    expect(assets.map(({ asset_id, dedup_key }) => ({ asset_id, dedup_key }))).toEqual([
      {
        asset_id: 'duplicate-a',
        dedup_key: buildDedupKey({ user: String(user), contentHash: 'same-hash' }),
      },
      { asset_id: 'duplicate-b', dedup_key: undefined },
    ]);
  });

  test('agent rows: asset_id = file_id, agent scope resolved via tool_resources, pointer backfilled', async () => {
    await Agent.create({
      id: 'agent-77',
      tool_resources: { file_search: { file_ids: ['agent-file-1'] } },
    });
    await seedFile({ file_id: 'agent-file-1', context: 'agents' });

    const result = await migrateFileAssetsBatch({ mongoose });

    expect(result.assetsCreated).toBe(1);
    expect(result.pointersBackfilled).toBe(1);
    const asset = await KnaufFileAsset.findOne({ asset_id: 'agent-file-1' }).lean();
    expect(asset.scope_type).toBe('agent');
    expect(asset.scope_id).toBe('agent-77');
    expect(asset.embed_route).toBe('/agent/embed');
    expect(asset.dedup_key).toBeUndefined();
    const row = await File.findOne({ file_id: 'agent-file-1' }).lean();
    expect(row.knauf_asset_id).toBe('agent-file-1');
  });

  test('a detached agent file falls back to user scope and is counted', async () => {
    await seedFile({ file_id: 'orphan-agent', context: 'agents' });

    const result = await migrateFileAssetsBatch({ mongoose });

    expect(result.agentScopeFallbacks).toBe(1);
    const asset = await KnaufFileAsset.findOne({ asset_id: 'orphan-agent' }).lean();
    expect(asset.scope_type).toBe('user');
  });

  test('known-incomplete rows map to failed + migration_inconsistent — never auto-embedded', async () => {
    await seedFile({ file_id: 'broken-1', knauf_asset_id: 'broken-1', embedded: false });

    const result = await migrateFileAssetsBatch({ mongoose });

    expect(result.incomplete).toBe(1);
    const asset = await KnaufFileAsset.findOne({ asset_id: 'broken-1' }).lean();
    expect(asset.status).toBe('failed');
    expect(asset.last_error_code).toBe('migration_inconsistent');
    expect(asset.active_generation).toBeNull();
  });

  // KK20-195 review R1 — the migration runs under runAsSystem (no plugin
  // injection), so the source row's tenant must be copied explicitly.
  test('copies the source row tenantId onto the created asset', async () => {
    await seedFile({ file_id: 'tenant-1', knauf_asset_id: 'tenant-1', tenantId: 't-42' });
    await seedFile({ file_id: 'no-tenant', knauf_asset_id: 'no-tenant' });

    await migrateFileAssetsBatch({ mongoose });

    const tenanted = await KnaufFileAsset.findOne({ asset_id: 'tenant-1' }).lean();
    expect(tenanted.tenantId).toBe('t-42');
    const plain = await KnaufFileAsset.findOne({ asset_id: 'no-tenant' }).lean();
    expect(plain.tenantId ?? null).toBeNull();
  });

  test('batches with a resume cursor and re-runs are idempotent (no duplicates)', async () => {
    for (let i = 0; i < 5; i++) {
      await seedFile({ file_id: `f-${i}`, knauf_asset_id: `f-${i}` });
    }

    const first = await migrateFileAssetsBatch({ mongoose, batchSize: 2 });
    expect(first.scanned).toBe(2);
    expect(first.done).toBe(false);
    const second = await migrateFileAssetsBatch({
      mongoose,
      batchSize: 2,
      resumeAfterId: first.lastId,
    });
    const third = await migrateFileAssetsBatch({
      mongoose,
      batchSize: 2,
      resumeAfterId: second.lastId,
    });
    expect(third.done).toBe(true);
    expect(await KnaufFileAsset.countDocuments({})).toBe(5);

    // Interrupted-and-rerun from scratch: zero new assets.
    const rerun = await migrateFileAssetsBatch({ mongoose, batchSize: 100 });
    expect(rerun.assetsCreated).toBe(0);
    expect(rerun.skippedExisting).toBe(5);
    expect(await KnaufFileAsset.countDocuments({})).toBe(5);
  });

  test('dryRun scans and reports without writing anything', async () => {
    await seedFile({ file_id: 'dry-1' });

    const result = await migrateFileAssetsBatch({ mongoose, dryRun: true });

    expect(result.scanned).toBe(1);
    expect(result.assetsCreated).toBe(0);
    expect(await KnaufFileAsset.countDocuments({})).toBe(0);
    const row = await File.findOne({ file_id: 'dry-1' }).lean();
    expect(row.knauf_asset_id).toBeUndefined();
  });
});
// End [knauf]
