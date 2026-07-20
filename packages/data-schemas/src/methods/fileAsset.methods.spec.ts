// [knauf] KK20-195 WP2 — state-machine tests for the FileAsset methods against
// a real Mongo (mongodb-memory-server): atomic-claim single-winner, execution-
// token fencing, tombstone semantics, and the dedup reservation race. These
// map to the accepted plan's §14 test-matrix rows: "Concurrent identical chat
// uploads", "Duplicate claim/delivery", "Heartbeat stalls", "Worker dies
// before RAG" (lease expiry), and "Delete while queued/processing".
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IKnaufFileAsset } from '~/types';
import { createFileAssetMethods, type ReserveAssetParams } from './fileAsset';
import fileAssetSchema from '~/schema/fileAsset';

let mongoServer: MongoMemoryServer;
let KnaufFileAsset: mongoose.Model<IKnaufFileAsset>;
let methods: ReturnType<typeof createFileAssetMethods>;

const baseParams = (overrides: Partial<ReserveAssetParams> = {}): ReserveAssetParams => ({
  asset_id: `asset-${crypto.randomUUID()}`,
  scope_type: 'user',
  scope_id: 'u1',
  target_index_profile: 'legacy-v0',
  vector_backend: 'pgvector',
  embed_route: '/embed',
  content_hash: 'hash-1',
  ...overrides,
});

const seedQueued = async (overrides: Partial<IKnaufFileAsset> = {}): Promise<IKnaufFileAsset> => {
  const doc = await KnaufFileAsset.create({
    ...baseParams(),
    status: 'queued',
    queued_at: new Date(Date.now() - 1000),
    next_attempt_at: new Date(Date.now() - 1000),
    ...overrides,
  });
  return doc.toObject();
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  KnaufFileAsset =
    mongoose.models.KnaufFileAsset ||
    mongoose.model<IKnaufFileAsset>('KnaufFileAsset', fileAssetSchema);
  methods = createFileAssetMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
  await KnaufFileAsset.init(); // unique/partial indexes must exist for race tests
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await KnaufFileAsset.deleteMany({});
});

describe('reserveAsset — the dedup reservation', () => {
  test('creates once, then reuses: second caller gets the SAME asset, created=false', async () => {
    const first = await methods.reserveAsset(baseParams({ dedup_key: 'k1', asset_id: 'a1' }));
    const second = await methods.reserveAsset(baseParams({ dedup_key: 'k1', asset_id: 'a2' }));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.asset.asset_id).toBe('a1');
  });

  test('a concurrent identical-upload race produces exactly one asset', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        methods.reserveAsset(baseParams({ dedup_key: 'race', asset_id: `a-${i}` })),
      ),
    );
    const assetIds = new Set(results.map((r) => r.asset.asset_id));
    expect(assetIds.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await KnaufFileAsset.countDocuments({ dedup_key: 'race' })).toBe(1);
  });

  test('non-dedup (agent) path is keyed by asset_id and is replay-idempotent', async () => {
    const p = baseParams({ asset_id: 'agent-a1', dedup_key: undefined });
    const first = await methods.reserveAsset(p);
    const replay = await methods.reserveAsset(p);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.asset.asset_id).toBe('agent-a1');
  });
});

describe('markQueued', () => {
  test('CAS uploading→queued stores the blob and stamps timestamps', async () => {
    await methods.reserveAsset(baseParams({ asset_id: 'q1', dedup_key: 'kq1' }));
    const queued = await methods.markQueued({
      asset_id: 'q1',
      blob: { path: 'p', bytes: 5, filename: 'scan.pdf' },
    });
    expect(queued?.status).toBe('queued');
    expect(queued?.blob?.path).toBe('p');
    expect(queued?.blob?.filename).toBe('scan.pdf');
    expect(queued?.next_attempt_at).toBeDefined();
  });

  test('refuses non-uploading states and tombstoned assets', async () => {
    await seedQueued({ asset_id: 'q2' });
    expect(await methods.markQueued({ asset_id: 'q2', blob: {} })).toBeNull();
    await methods.tombstoneForDelete({ asset_id: 'q2' });
    expect(await methods.markQueued({ asset_id: 'q2', blob: {} })).toBeNull();
  });

  test('fails only an abandoned uploading reservation', async () => {
    await methods.reserveAsset(baseParams({ asset_id: 'stale-upload', dedup_key: 'stale-key' }));
    const failed = await methods.failStaleUpload({
      asset_id: 'stale-upload',
      error_code: 'upload_interrupted_reupload_required',
    });
    expect(failed?.status).toBe('failed');
    expect(failed?.last_error_code).toBe('upload_interrupted_reupload_required');
    expect(
      await methods.failStaleUpload({
        asset_id: 'stale-upload',
        error_code: 'upload_interrupted_reupload_required',
      }),
    ).toBeNull();
  });
});

describe('claimNextDue — atomic claim (plan §5.1)', () => {
  test('one winner: a second immediate claim finds nothing', async () => {
    await seedQueued({ asset_id: 'c1' });
    const won = await methods.claimNextDue({ workerId: 'w1', leaseMs: 60_000 });
    const lost = await methods.claimNextDue({ workerId: 'w2', leaseMs: 60_000 });
    expect(won?.asset_id).toBe('c1');
    expect(won?.status).toBe('processing');
    expect(won?.execution_token).toBeDefined();
    expect(won?.attempt_count).toBe(1);
    expect(won?.target_generation).toBe(1);
    expect(lost).toBeNull();
  });

  test('claims oldest-due first', async () => {
    await seedQueued({ asset_id: 'old', queued_at: new Date(Date.now() - 5000) });
    await seedQueued({ asset_id: 'new', queued_at: new Date(Date.now() - 1000) });
    const first = await methods.claimNextDue({ workerId: 'w', leaseMs: 60_000 });
    expect(first?.asset_id).toBe('old');
  });

  test('an expired processing lease is reclaimable with a NEW token and generation', async () => {
    await seedQueued({ asset_id: 'stale' });
    const first = await methods.claimNextDue({ workerId: 'w1', leaseMs: 60_000 });
    await KnaufFileAsset.updateOne(
      { asset_id: 'stale' },
      { $set: { lease_expires_at: new Date(Date.now() - 1) } },
    );
    const reclaimed = await methods.claimNextDue({ workerId: 'w2', leaseMs: 60_000 });
    expect(reclaimed?.asset_id).toBe('stale');
    expect(reclaimed?.execution_token).not.toBe(first?.execution_token);
    expect(reclaimed?.attempt_count).toBe(2);
    expect(reclaimed?.target_generation).toBe(2);
  });

  test('tombstoned and not-yet-due work is never claimed', async () => {
    await seedQueued({ asset_id: 'tomb' });
    await methods.tombstoneForDelete({ asset_id: 'tomb' });
    await seedQueued({ asset_id: 'later', next_attempt_at: new Date(Date.now() + 60_000) });
    expect(await methods.claimNextDue({ workerId: 'w', leaseMs: 60_000 })).toBeNull();
  });
});

describe('execution-token fencing', () => {
  const claim = async (asset_id: string) => {
    await seedQueued({ asset_id });
    return (await methods.claimNextDue({ workerId: 'w1', leaseMs: 60_000 }))!;
  };

  test('heartbeat extends only for the current token', async () => {
    const c = await claim('h1');
    expect(
      await methods.heartbeatClaim({
        asset_id: 'h1',
        execution_token: c.execution_token!,
        leaseMs: 90_000,
      }),
    ).toBe(true);
    expect(
      await methods.heartbeatClaim({ asset_id: 'h1', execution_token: 'stale', leaseMs: 90_000 }),
    ).toBe(false);
  });

  test('requeueClaim is token-fenced and atomically clears the lease', async () => {
    const c = await claim('r1');
    expect(
      await methods.requeueClaim({
        asset_id: 'r1',
        execution_token: 'stale',
        next_attempt_at: new Date(),
      }),
    ).toBe(false);
    expect(
      await methods.requeueClaim({
        asset_id: 'r1',
        execution_token: c.execution_token!,
        next_attempt_at: new Date(),
        error_code: 'embed_throttled',
      }),
    ).toBe(true);
    const row = await KnaufFileAsset.findOne({ asset_id: 'r1' }).lean();
    expect(row?.status).toBe('queued');
    expect(row?.lease_owner).toBeUndefined();
    expect(row?.execution_token).toBeUndefined();
    expect(row?.last_error_code).toBe('embed_throttled');
  });

  test('failClaim truncates the detail and clears the lease', async () => {
    const c = await claim('f1');
    await methods.failClaim({
      asset_id: 'f1',
      execution_token: c.execution_token!,
      error_code: 'attempts_exhausted',
      error_detail: 'x'.repeat(5000),
    });
    const row = await KnaufFileAsset.findOne({ asset_id: 'f1' }).lean();
    expect(row?.status).toBe('failed');
    expect(row?.last_error_detail?.length).toBeLessThanOrEqual(2000);
    expect(row?.execution_token).toBeUndefined();
  });

  test('activateGeneration: winner activates; stale token and superseded generation no-op', async () => {
    const c = await claim('a1');
    // Stale token.
    expect(
      await methods.activateGeneration({
        asset_id: 'a1',
        execution_token: 'stale',
        target_generation: c.target_generation,
        target_index_profile: 'legacy-v0',
      }),
    ).toBeNull();
    // Superseded generation (a reclaim bumped it).
    expect(
      await methods.activateGeneration({
        asset_id: 'a1',
        execution_token: c.execution_token!,
        target_generation: c.target_generation + 1,
        target_index_profile: 'legacy-v0',
      }),
    ).toBeNull();
    // The rightful claim wins.
    const activated = await methods.activateGeneration({
      asset_id: 'a1',
      execution_token: c.execution_token!,
      target_generation: c.target_generation,
      target_index_profile: 'legacy-v0',
    });
    expect(activated?.status).toBe('ready');
    expect(activated?.active_generation).toBe(c.target_generation);
    expect(activated?.active_index_profile).toBe('legacy-v0');
    expect(activated?.execution_token).toBeUndefined();
  });

  test('a tombstone set mid-flight blocks activation (delete-while-processing)', async () => {
    const c = await claim('t1');
    await methods.tombstoneForDelete({ asset_id: 't1' });
    expect(
      await methods.activateGeneration({
        asset_id: 't1',
        execution_token: c.execution_token!,
        target_generation: c.target_generation,
        target_index_profile: 'legacy-v0',
      }),
    ).toBeNull();
  });
});

describe('retry and deletion lifecycle', () => {
  test('retryFailed: ONLY failed→queued, resetting attempts and errors', async () => {
    await seedQueued({ asset_id: 'rf1' });
    expect(await methods.retryFailed({ asset_id: 'rf1' })).toBeNull(); // queued → no-op
    const c = (await methods.claimNextDue({ workerId: 'w', leaseMs: 60_000 }))!;
    await methods.failClaim({
      asset_id: 'rf1',
      execution_token: c.execution_token!,
      error_code: 'rag_5xx',
    });
    const retried = await methods.retryFailed({ asset_id: 'rf1' });
    expect(retried?.status).toBe('queued');
    expect(retried?.attempt_count).toBe(0);
    expect(retried?.last_error_code).toBeNull();
  });

  test('tombstoneForDelete is idempotent under concurrent last-reference deletes', async () => {
    await seedQueued({ asset_id: 'd1' });
    const [first, second] = await Promise.all([
      methods.tombstoneForDelete({ asset_id: 'd1' }),
      methods.tombstoneForDelete({ asset_id: 'd1' }),
    ]);
    expect(first?.status).toBe('deleting');
    expect(second?.status).toBe('deleting');
    expect(first?.delete_requested_at).toBeDefined();
  });

  test('delete_failed stays visible/retryable; removal only from deleting states', async () => {
    await seedQueued({ asset_id: 'd2' });
    expect(await methods.removeAsset({ asset_id: 'd2' })).toBe(false); // not deleting yet
    await methods.tombstoneForDelete({ asset_id: 'd2' });
    expect(
      await methods.markDeleteFailed({ asset_id: 'd2', error_code: 'delete_blob_failed' }),
    ).toBe(true);
    expect(await methods.retryDelete({ asset_id: 'd2' })).toBe(true);
    expect(await methods.removeAsset({ asset_id: 'd2' })).toBe(true);
    expect(await KnaufFileAsset.countDocuments({ asset_id: 'd2' })).toBe(0);
  });
});

// KK20-195 review R9 — cleanup debt is token-less additive bookkeeping.
describe('stale-generation cleanup debt (review R9)', () => {
  test('record adds once ($addToSet), clear pulls the confirmed entry', async () => {
    await seedQueued({ asset_id: 'debt-1' });

    expect(await methods.recordStaleGeneration({ asset_id: 'debt-1', generation: 2 })).toBe(true);
    // Idempotent: the same generation is never listed twice ($addToSet).
    await methods.recordStaleGeneration({ asset_id: 'debt-1', generation: 2 });
    await methods.recordStaleGeneration({ asset_id: 'debt-1', generation: 3 });

    let asset = await methods.getAssetByAssetId('debt-1');
    expect(asset?.stale_generations).toEqual([2, 3]);

    expect(await methods.clearStaleGeneration({ asset_id: 'debt-1', generation: 2 })).toBe(true);
    asset = await methods.getAssetByAssetId('debt-1');
    expect(asset?.stale_generations).toEqual([3]);
  });

  test('recording works without an execution token (ownership already lost)', async () => {
    await seedQueued({ asset_id: 'debt-2' });
    // No claim, no token — exactly the lost-ownership situation where the
    // debt matters most.
    expect(await methods.recordStaleGeneration({ asset_id: 'debt-2', generation: 5 })).toBe(true);
  });

  // KK20-195 review F8 (re-review) — matchedCount semantics: the boolean means
  // "the debt is persisted on the row", so an idempotent re-record is still
  // success and only an ABSENT row is failure (the caller alerts on false).
  test('re-recording an already-listed generation still returns true (idempotent)', async () => {
    await seedQueued({ asset_id: 'debt-3' });
    expect(await methods.recordStaleGeneration({ asset_id: 'debt-3', generation: 7 })).toBe(true);
    expect(await methods.recordStaleGeneration({ asset_id: 'debt-3', generation: 7 })).toBe(true);
    const asset = await methods.getAssetByAssetId('debt-3');
    expect(asset?.stale_generations).toEqual([7]);
  });

  test('returns false when the asset row is absent (generation is orphaned)', async () => {
    expect(await methods.recordStaleGeneration({ asset_id: 'gone', generation: 1 })).toBe(false);
  });
});

describe('admission-control counters', () => {
  test('counts and sums only non-terminal work in the scope', async () => {
    await seedQueued({ asset_id: 's1', scope_id: 'u1', blob: { bytes: 10 } });
    await seedQueued({ asset_id: 's2', scope_id: 'u1', blob: { bytes: 20 } });
    await seedQueued({ asset_id: 's3', scope_id: 'u1', status: 'ready', blob: { bytes: 999 } });
    await seedQueued({ asset_id: 'other', scope_id: 'u2', blob: { bytes: 500 } });

    expect(await methods.countActiveByScope({ scope_type: 'user', scope_id: 'u1' })).toBe(2);
    expect(await methods.sumActiveBytesByScope({ scope_type: 'user', scope_id: 'u1' })).toBe(30);
  });

  // KK20-195 review F9 (re-review) — the byte sum counts reserved_bytes for an
  // 'uploading' row (no blob yet) and blob.bytes once stored; $max coalesces so
  // a queued row that carries both is never double-counted.
  test('byte sum uses reserved_bytes while uploading and blob.bytes once stored', async () => {
    await seedQueued({
      asset_id: 'up',
      scope_id: 'ub',
      status: 'uploading',
      blob: undefined,
      reserved_bytes: 300,
    });
    await seedQueued({ asset_id: 'qd', scope_id: 'ub', blob: { bytes: 50 }, reserved_bytes: 40 });

    // 300 (reserved, no blob) + max(50, 40) = 350
    expect(await methods.sumActiveBytesByScope({ scope_type: 'user', scope_id: 'ub' })).toBe(350);
  });
});

describe('claimAsset — claim one specific asset (KK20-195 WP3b)', () => {
  // KK20-195 review R2 — the sync path claims without a generation bump so
  // activation records generation 0 (unversioned legacy vectors), matching
  // the WP2d migration's labeling. The worker path keeps incrementing.
  test('legacyGeneration keeps target_generation at 0 (sync legacy writes)', async () => {
    await seedQueued({ asset_id: 'legacy-claim' });

    const claimed = await methods.claimAsset({
      asset_id: 'legacy-claim',
      workerId: 'sync-request',
      leaseMs: 60_000,
      legacyGeneration: true,
    });

    expect(claimed?.target_generation).toBe(0);
    expect(claimed?.attempt_count).toBe(1); // attempts still count
    expect(claimed?.execution_token).toBeDefined(); // fencing unchanged

    const activated = await methods.activateGeneration({
      asset_id: 'legacy-claim',
      execution_token: claimed!.execution_token!,
      target_generation: 0,
      target_index_profile: claimed!.target_index_profile,
    });
    expect(activated?.active_generation).toBe(0);
    expect(activated?.status).toBe('ready');
  });

  test('claims exactly the requested asset with lease + token + increments', async () => {
    await seedQueued({ asset_id: 'other-older', queued_at: new Date(Date.now() - 60_000) });
    await seedQueued({ asset_id: 'mine' });

    const claimed = await methods.claimAsset({
      asset_id: 'mine',
      workerId: 'req-1',
      leaseMs: 60_000,
    });

    expect(claimed?.asset_id).toBe('mine');
    expect(claimed?.status).toBe('processing');
    expect(claimed?.execution_token).toBeDefined();
    expect(claimed?.attempt_count).toBe(1);
    expect(claimed?.target_generation).toBe(1);
    // The older asset was NOT touched — this is not oldest-due claiming.
    const other = await KnaufFileAsset.findOne({ asset_id: 'other-older' }).lean();
    expect(other?.status).toBe('queued');
  });

  test('one winner under concurrency; tombstoned/processing assets refuse the claim', async () => {
    await seedQueued({ asset_id: 'race-me' });
    const [a, b] = await Promise.all([
      methods.claimAsset({ asset_id: 'race-me', workerId: 'w1', leaseMs: 60_000 }),
      methods.claimAsset({ asset_id: 'race-me', workerId: 'w2', leaseMs: 60_000 }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);

    await seedQueued({ asset_id: 'tomb-claim' });
    await methods.tombstoneForDelete({ asset_id: 'tomb-claim' });
    expect(
      await methods.claimAsset({ asset_id: 'tomb-claim', workerId: 'w', leaseMs: 60_000 }),
    ).toBeNull();
  });
});
// End [knauf]
