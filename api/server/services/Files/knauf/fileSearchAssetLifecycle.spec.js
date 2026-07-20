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
  shouldRecoverStaleSyncReplay,
  shouldRecoverIncompleteFinalization,
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
    asset_id: `asset-${Math.random().toString(36).slice(2)}`,
    entityId: 'agent-1',
    messageAttachment: true,
    contentHash: 'h1',
    azureSearchForAgents: false,
    ...overrides,
  });

describe('reserveForUpload (KK20-195 WP3b)', () => {
  test('chat uploads reserve by scope+hash dedup key; identical uploads coalesce', async () => {
    const first = await reserve({ asset_id: 'asset-1' });
    const second = await reserve({ asset_id: 'asset-2' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.asset.asset_id).toBe('asset-1');
    expect(first.asset.scope_type).toBe('user');
    expect(first.asset.embed_route).toBe('/embed');
  });

  test('agent-library uploads stay un-deduplicated and agent-scoped', async () => {
    const a = await reserve({ asset_id: 'asset-a1', messageAttachment: false, contentHash: 'h1' });
    const b = await reserve({ asset_id: 'asset-a2', messageAttachment: false, contentHash: 'h1' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true); // same content, DIFFERENT assets
    expect(a.asset.scope_type).toBe('agent');
    expect(a.asset.scope_id).toBe('agent-1');
    expect(a.asset.embed_route).toBe('/agent/embed');
    expect(a.asset.dedup_key).toBeUndefined();
  });

  test('azure routing applies to agent assets when enabled', async () => {
    const a = await reserve({
      asset_id: 'asset-az1',
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

describe('classifyExistingAsset — reclaim of abandoned reservations (KK20-195 review)', () => {
  const now = new Date('2026-07-17T12:00:00Z');
  const ago = (ms) => new Date(now.getTime() - ms);

  test('processing with a live lease is a genuine conflict (in_progress)', () => {
    expect(
      classifyExistingAsset(
        { status: 'processing', lease_expires_at: new Date(now.getTime() + 60_000) },
        { now },
      ),
    ).toBe('in_progress');
  });

  test('processing past its lease is reclaimable', () => {
    expect(
      classifyExistingAsset({ status: 'processing', lease_expires_at: ago(1000) }, { now }),
    ).toBe('reclaim');
  });

  test('recently-updated uploading/queued stays in_progress', () => {
    expect(classifyExistingAsset({ status: 'uploading', updatedAt: ago(1000) }, { now })).toBe(
      'in_progress',
    );
    expect(classifyExistingAsset({ status: 'queued', updatedAt: ago(1000) }, { now })).toBe(
      'in_progress',
    );
  });

  test('uploading/queued idle past the reclaim window is reclaimable', () => {
    const stale = ago(20 * 60 * 1000); // > the 15m default window
    expect(classifyExistingAsset({ status: 'uploading', updatedAt: stale }, { now })).toBe(
      'reclaim',
    );
    expect(classifyExistingAsset({ status: 'queued', updatedAt: stale }, { now })).toBe('reclaim');
  });

  test('reclaimable=false (worker enabled) → abandoned asset stays in_progress, not reclaim', () => {
    // With the worker on, its expired-lease re-claim + the reconciler own
    // recovery; the upload path must not delete the asset out from under them.
    const stale = ago(20 * 60 * 1000);
    expect(
      classifyExistingAsset(
        { status: 'processing', lease_expires_at: ago(1000) },
        { now, reclaimable: false },
      ),
    ).toBe('in_progress');
    expect(
      classifyExistingAsset({ status: 'queued', updatedAt: stale }, { now, reclaimable: false }),
    ).toBe('in_progress');
  });
});

describe('stale synchronous replay recovery', () => {
  const now = new Date('2026-07-20T12:00:00Z');
  const stale = new Date(now.getTime() - 20 * 60 * 1000);

  test('re-enters upload recovery only for stale work with no worker or async acceptance', () => {
    const asset = { status: 'queued', updatedAt: stale };
    expect(
      shouldRecoverStaleSyncReplay({ asset, asyncAccepted: false, workerEnabled: false, now }),
    ).toBe(true);
    expect(
      shouldRecoverStaleSyncReplay({ asset, asyncAccepted: true, workerEnabled: false, now }),
    ).toBe(false);
    expect(
      shouldRecoverStaleSyncReplay({ asset, asyncAccepted: false, workerEnabled: true, now }),
    ).toBe(false);
  });

  test('keeps a fresh replay joined to the in-flight upload', () => {
    expect(
      shouldRecoverStaleSyncReplay({
        asset: { status: 'queued', updatedAt: new Date(now.getTime() - 1000) },
        asyncAccepted: false,
        workerEnabled: false,
        now,
      }),
    ).toBe(false);
  });

  test('re-enters finalization only for an active asset with an unfinished marker', () => {
    expect(
      shouldRecoverIncompleteFinalization({
        asset: { status: 'ready', active_generation: 0, delete_requested_at: null },
        file: { knauf_upload_finalized: false },
      }),
    ).toBe(true);
    expect(
      shouldRecoverIncompleteFinalization({
        asset: { status: 'ready', active_generation: null, delete_requested_at: null },
        file: { knauf_upload_finalized: false },
      }),
    ).toBe(false);
    expect(
      shouldRecoverIncompleteFinalization({
        asset: { status: 'ready', active_generation: 0, delete_requested_at: null },
        file: { knauf_upload_finalized: true },
      }),
    ).toBe(false);
    expect(
      shouldRecoverIncompleteFinalization({
        asset: { status: 'processing', active_generation: 0, delete_requested_at: null },
        file: { knauf_upload_finalized: false },
      }),
    ).toBe(false);
  });
});

describe('recordSyncEmbed — sync execution through the asset (rollout step 4)', () => {
  const queueAsset = async (asset_id) => {
    const { asset } = await reserve({ asset_id });
    await db.markQueued({ asset_id: asset.asset_id, blob: { path: '/p', bytes: 5 } });
    return asset.asset_id;
  };

  test('success: claim → embed → activated ready generation', async () => {
    const id = await queueAsset('s1');
    const cleanupGeneration = jest.fn();
    const result = await recordSyncEmbed({
      db,
      asset_id: id,
      createdThisRequest: true,
      logger,
      embed: async (target) => ({ embedded: true, filename: 'doc.pdf', target }),
      cleanupGeneration,
    });
    expect(result.embedded).toBe(true);
    expect(result.target).toEqual({ generation: 1, index_profile: 'legacy-v0' });
    expect(cleanupGeneration).not.toHaveBeenCalled();
    const asset = await db.getAssetByAssetId(id);
    expect(asset.status).toBe('ready');
    expect(asset.active_generation).toBe(1);
    expect(asset.target_generation).toBe(1);
    expect(asset.active_index_profile).toBe('legacy-v0');
    expect(asset.execution_token).toBeUndefined();
  });

  test('failure on a request-created asset confirms ownership before caller compensation', async () => {
    const id = await queueAsset('s2');
    const cleanupGeneration = jest.fn().mockResolvedValue(undefined);
    const thrown = await recordSyncEmbed({
      db,
      asset_id: id,
      createdThisRequest: true,
      logger,
      embed: async () => {
        throw new Error('embed exploded');
      },
      cleanupGeneration,
    }).catch((error) => error);
    expect(thrown).toMatchObject({ message: 'embed exploded', knaufOwnedFailure: true });
    expect(cleanupGeneration).toHaveBeenCalledWith({
      generation: 1,
      index_profile: 'legacy-v0',
    });
    // The helper never removes the ledger/blob itself; the caller compensates
    // only after seeing knaufOwnedFailure.
    expect((await db.getAssetByAssetId(id)).status).toBe('failed');
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
        cleanupGeneration: jest.fn(),
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
        cleanupGeneration: jest.fn(),
      }),
    ).rejects.toMatchObject({
      knaufCode: 'file_indexing_in_progress',
      knaufPreserveLifecycle: true,
    });
  });

  test('a lost activation CAS (asset tombstoned mid-embed) throws instead of reporting success', async () => {
    const id = await queueAsset('s5');
    const cleanupGeneration = jest.fn().mockResolvedValue(undefined);
    await expect(
      recordSyncEmbed({
        db,
        asset_id: id,
        createdThisRequest: true,
        logger,
        embed: async () => {
          // A concurrent last-reference delete tombstones the shared asset
          // while we embed → the post-embed activation CAS misses.
          await db.tombstoneForDelete({ asset_id: id });
          return { embedded: true };
        },
        cleanupGeneration,
      }),
    ).rejects.toMatchObject({
      knaufCode: 'file_indexing_activation_lost',
      knaufPreserveLifecycle: true,
    });
    expect(cleanupGeneration).toHaveBeenCalledWith({
      generation: 1,
      index_profile: 'legacy-v0',
    });
    expect((await db.getAssetByAssetId(id)).status).toBe('deleting');
  });

  test('a failed activation-lost cleanup is durable reconciliation debt', async () => {
    const id = await queueAsset('s6');
    await expect(
      recordSyncEmbed({
        db,
        asset_id: id,
        createdThisRequest: true,
        logger,
        embed: async () => {
          await db.tombstoneForDelete({ asset_id: id });
          return { embedded: true };
        },
        cleanupGeneration: async () => {
          throw new Error('RAG delete unavailable');
        },
      }),
    ).rejects.toMatchObject({
      knaufCode: 'file_indexing_activation_lost',
      knaufCleanupDeferred: true,
    });
    const asset = await db.getAssetByAssetId(id);
    expect(asset.status).toBe('deleting');
    expect(asset.stale_generations).toContain(1);
  });

  test('a reclaimed successor survives the stale claimant activation loss', async () => {
    const id = await queueAsset('s7');
    const cleanupGeneration = jest.fn().mockResolvedValue(undefined);
    await expect(
      recordSyncEmbed({
        db,
        asset_id: id,
        createdThisRequest: true,
        leaseMs: 1,
        logger,
        embed: async () => {
          const successor = await db.claimAsset({
            asset_id: id,
            workerId: 'successor',
            leaseMs: 60_000,
            now: new Date(Date.now() + 5_000),
          });
          expect(successor.target_generation).toBe(2);
          return { embedded: true };
        },
        cleanupGeneration,
      }),
    ).rejects.toMatchObject({ knaufCode: 'file_indexing_activation_lost' });

    expect(cleanupGeneration).toHaveBeenCalledWith({
      generation: 1,
      index_profile: 'legacy-v0',
    });
    const asset = await db.getAssetByAssetId(id);
    expect(asset.status).toBe('processing');
    expect(asset.target_generation).toBe(2);
    expect(asset.lease_owner).toBe('successor');
  });

  test('alerts when generation cleanup debt cannot be attached to a removed asset', async () => {
    const id = await queueAsset('s8');
    const thrown = await recordSyncEmbed({
      db,
      asset_id: id,
      createdThisRequest: true,
      logger,
      embed: async () => {
        await db.tombstoneForDelete({ asset_id: id });
        await db.removeAsset({ asset_id: id });
        return { embedded: true };
      },
      cleanupGeneration: async () => {
        throw new Error('RAG delete unavailable');
      },
    }).catch((error) => error);

    expect(thrown).toMatchObject({
      knaufCode: 'file_indexing_activation_lost',
      knaufPreserveLifecycle: true,
      knaufCleanupDebtUnconfirmed: true,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[alert][cleanup_debt_unconfirmed]'),
    );
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
        blob: { path: '/blob/doc.pdf' },
      }),
    ).toMatchObject({ status: 'failed', ready: false, retryable: true, error_code: 'rag_5xx' });
    expect(
      buildIndexingProjection({
        status: 'failed',
        active_generation: null,
        last_error_code: 'upload_interrupted_reupload_required',
      }),
    ).toMatchObject({ status: 'failed', ready: false, retryable: false });
  });

  test('a ready generation stays ready during a replacement re-index', () => {
    expect(buildIndexingProjection({ status: 'processing', active_generation: 3 })).toMatchObject({
      status: 'processing',
      ready: true,
    });
  });
});
// End [knauf]
