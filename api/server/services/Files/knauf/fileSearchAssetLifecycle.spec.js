// [knauf] KK20-195 WP3b — seam test for the reservation-first upload
// lifecycle: dedup coalescing before any physical work, the existing-asset
// branch table, sync claim→embed→activate recording, and the failure path
// that removes what the request created ("failure leaves nothing" for
// pre-WP5 clients). Runs the REAL FileAsset methods on mongodb-memory-server.
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { fileAssetSchema } = require('@librechat/data-schemas');
const { createFileAssetMethods } = require('@librechat/data-schemas');
const {
  reserveForUpload,
  classifyExistingAsset,
  recordSyncEmbed,
  buildIndexingProjection,
} = require('./fileSearchAssetLifecycle');

let mongoServer;
let KnaufFileAsset;
let db;
const logger = { warn: jest.fn() };

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  KnaufFileAsset =
    mongoose.models.KnaufFileAsset || mongoose.model('KnaufFileAsset', fileAssetSchema);
  db = createFileAssetMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
  await KnaufFileAsset.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await KnaufFileAsset.deleteMany({});
  jest.clearAllMocks();
});

const reserve = (overrides = {}) =>
  reserveForUpload({
    db,
    userId: 'u1',
    file_id: `f-${Math.random().toString(36).slice(2)}`,
    entityId: 'agent-1',
    messageAttachment: true,
    contentHash: 'h1',
    azureSearchForAgents: false,
    ...overrides,
  });

describe('reserveForUpload (KK20-195 WP3b)', () => {
  test('chat uploads reserve by scope+hash dedup key; identical uploads coalesce', async () => {
    const first = await reserve({ file_id: 'f1' });
    const second = await reserve({ file_id: 'f2' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.asset.asset_id).toBe('f1');
    expect(first.asset.scope_type).toBe('user');
    expect(first.asset.embed_route).toBe('/embed');
  });

  test('agent-library uploads stay un-deduplicated and agent-scoped', async () => {
    const a = await reserve({ file_id: 'a1', messageAttachment: false, contentHash: 'h1' });
    const b = await reserve({ file_id: 'a2', messageAttachment: false, contentHash: 'h1' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true); // same content, DIFFERENT assets
    expect(a.asset.scope_type).toBe('agent');
    expect(a.asset.scope_id).toBe('agent-1');
    expect(a.asset.embed_route).toBe('/agent/embed');
    expect(a.asset.dedup_key).toBeUndefined();
  });

  test('azure routing applies to agent assets when enabled', async () => {
    const a = await reserve({
      file_id: 'az1',
      messageAttachment: false,
      azureSearchForAgents: true,
    });
    expect(a.asset.vector_backend).toBe('azure_search');
  });
});

describe('classifyExistingAsset — the §6.1 branch table', () => {
  test.each([
    [{ status: 'ready', active_index_profile: 'legacy-v0' }, 'reuse'],
    [{ status: 'ready', active_index_profile: 'older-profile' }, 'reuse_stale_profile'],
    [{ status: 'uploading' }, 'in_progress'],
    [{ status: 'queued' }, 'in_progress'],
    [{ status: 'processing' }, 'in_progress'],
    [{ status: 'failed' }, 'retry_failed'],
    [{ status: 'deleting' }, 'deleting'],
    [{ status: 'delete_failed' }, 'deleting'],
    [
      { status: 'ready', active_index_profile: 'legacy-v0', delete_requested_at: new Date() },
      'deleting',
    ],
  ])('%o → %s', (asset, expected) => {
    expect(classifyExistingAsset(asset)).toBe(expected);
  });
});

describe('recordSyncEmbed — sync execution through the asset (rollout step 4)', () => {
  const queueAsset = async (asset_id) => {
    const { asset } = await reserve({ file_id: asset_id });
    await db.markQueued({ asset_id: asset.asset_id, blob: { path: '/p', bytes: 5 } });
    return asset.asset_id;
  };

  test('success: claim → embed → activated ready generation', async () => {
    const id = await queueAsset('s1');
    const result = await recordSyncEmbed({
      db,
      asset_id: id,
      createdThisRequest: true,
      logger,
      embed: async () => ({ embedded: true, filename: 'doc.pdf' }),
    });
    expect(result.embedded).toBe(true);
    const asset = await db.getAssetByAssetId(id);
    expect(asset.status).toBe('ready');
    expect(asset.active_generation).toBe(1);
    expect(asset.active_index_profile).toBe('legacy-v0');
    expect(asset.execution_token).toBeUndefined();
  });

  test('failure on a request-created asset removes the reservation and rethrows', async () => {
    const id = await queueAsset('s2');
    await expect(
      recordSyncEmbed({
        db,
        asset_id: id,
        createdThisRequest: true,
        logger,
        embed: async () => {
          throw new Error('embed exploded');
        },
      }),
    ).rejects.toThrow('embed exploded');
    // "Failure leaves nothing": the asset this request created is gone.
    expect(await db.getAssetByAssetId(id)).toBeNull();
  });

  test('failure on a PRE-EXISTING asset keeps it as failed (retryable), not removed', async () => {
    const id = await queueAsset('s3');
    await expect(
      recordSyncEmbed({
        db,
        asset_id: id,
        createdThisRequest: false,
        logger,
        embed: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    const asset = await db.getAssetByAssetId(id);
    expect(asset.status).toBe('failed');
    expect(asset.last_error_code).toBe('embed_failed_sync');
  });

  test('an already-claimed asset surfaces a stable in-progress conflict', async () => {
    const id = await queueAsset('s4');
    await db.claimAsset({ asset_id: id, workerId: 'other', leaseMs: 60_000 });
    await expect(
      recordSyncEmbed({
        db,
        asset_id: id,
        createdThisRequest: true,
        logger,
        embed: async () => ({ embedded: true }),
      }),
    ).rejects.toMatchObject({ knaufCode: 'file_indexing_in_progress' });
  });
});

describe('buildIndexingProjection', () => {
  test('no asset (non-file_search uploads) projects ready', () => {
    expect(buildIndexingProjection(null)).toEqual({
      status: 'ready',
      ready: true,
      retryable: false,
      error_code: null,
      queued_at: null,
    });
  });

  test('queued asset projects pending; failed projects retryable', () => {
    expect(
      buildIndexingProjection({ status: 'queued', active_generation: null, queued_at: null }),
    ).toMatchObject({ status: 'queued', ready: false, retryable: false });
    expect(
      buildIndexingProjection({
        status: 'failed',
        active_generation: null,
        last_error_code: 'rag_5xx',
      }),
    ).toMatchObject({ status: 'failed', ready: false, retryable: true, error_code: 'rag_5xx' });
  });

  test('a ready generation stays ready during a replacement re-index', () => {
    expect(buildIndexingProjection({ status: 'processing', active_generation: 3 })).toMatchObject({
      status: 'processing',
      ready: true,
    });
  });
});
// End [knauf]
