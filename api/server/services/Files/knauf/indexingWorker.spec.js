// [knauf] KK20-195 WP4a — seam test for the worker claim loop against the
// REAL FileAsset state machine (mongodb-memory-server) and a FAKE
// generation-safe RAG (plan allows WP4 development against a fake until WP1
// lands). Covers the plan-§14 worker rows: duplicate claim (single winner),
// worker-dies-mid-embed → lease reclaim with a new token+generation, late
// completion CAS-miss cleans only its own generation, retry classification,
// tombstone mid-processing, and SIGTERM stop-claiming.
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { fileAssetSchema, createFileAssetMethods } = require('@librechat/data-schemas');
const {
  createIndexingWorker,
  classifyWorkerError,
  computeNextAttemptAt,
  generationsToClean,
} = require('./indexingWorker');

let mongoServer;
let KnaufFileAsset;
let db;

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

/** In-memory generation-safe RAG: deterministic keys, upsert, per-generation delete. */
const createFakeRag = () => {
  const written = [];
  const deleted = [];
  const failures = [];
  return {
    written,
    deleted,
    failWith: (error) => failures.push(error),
    async embedGeneration({ asset_id, generation, index_profile }) {
      if (failures.length > 0) {
        throw failures.shift();
      }
      written.push(`${asset_id}:${generation}`);
      return { status: 'ready', asset_id, generation, index_profile };
    },
    async deleteGeneration({ asset_id, generation }) {
      deleted.push(`${asset_id}:${generation}`);
    },
  };
};

const httpError = (status) => Object.assign(new Error(`http ${status}`), { status });

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

const seedQueued = (overrides = {}) =>
  KnaufFileAsset.create({
    asset_id: overrides.asset_id ?? 'a1',
    scope_type: 'user',
    scope_id: 'u1',
    target_index_profile: 'legacy-v0',
    vector_backend: 'pgvector',
    embed_route: '/embed',
    status: 'queued',
    blob: { source: 'local', path: '/blob/a', bytes: 10, mime: 'application/pdf' },
    queued_at: overrides.queued_at ?? new Date(),
    next_attempt_at: new Date(0),
    ...overrides,
  });

const buildWorker = ({ ragClient, workerId = 'w-test', ...overrides } = {}) =>
  createIndexingWorker({
    db,
    ragClient: ragClient ?? createFakeRag(),
    resolveScope: async () => ({ userId: 'u1', entityId: 'u1' }),
    markFilesEmbedded: jest.fn().mockResolvedValue(undefined),
    logger,
    workerId,
    ...overrides,
  });

describe('success path (claim → embed → activate)', () => {
  test('queued asset becomes ready with an active generation; lease cleared; File.embedded lockstep', async () => {
    await seedQueued({ asset_id: 's1' });
    const rag = createFakeRag();
    const markFilesEmbedded = jest.fn().mockResolvedValue(undefined);
    const worker = createIndexingWorker({
      db,
      ragClient: rag,
      resolveScope: async () => ({ userId: 'u1', entityId: 'u1' }),
      markFilesEmbedded,
      logger,
      workerId: 'w1',
    });

    const { outcome } = await worker.processNextDue();

    expect(outcome).toBe('ready');
    expect(rag.written).toEqual(['s1:1']); // generation assigned by the claim
    const asset = await db.getAssetByAssetId('s1');
    expect(asset.status).toBe('ready');
    expect(asset.active_generation).toBe(1);
    expect(asset.active_index_profile).toBe('legacy-v0');
    expect(asset.execution_token).toBeUndefined(); // lease cleared with the transition
    expect(asset.lease_owner).toBeUndefined();
    expect(markFilesEmbedded).toHaveBeenCalledWith('s1');
  });

  test('idle when nothing is due', async () => {
    const worker = buildWorker({});
    expect((await worker.processNextDue()).outcome).toBe('idle');
  });
});

describe('duplicate claim — single winner (plan §14)', () => {
  test('two workers race one queued asset: exactly one embed happens', async () => {
    await seedQueued({ asset_id: 'race-1' });
    const rag = createFakeRag();
    const w1 = buildWorker({ ragClient: rag, workerId: 'w1' });
    const w2 = buildWorker({ ragClient: rag, workerId: 'w2' });

    const [r1, r2] = await Promise.all([w1.processNextDue(), w2.processNextDue()]);

    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toEqual(['idle', 'ready']);
    expect(rag.written).toEqual(['race-1:1']); // one write, one generation
  });
});

describe('worker dies mid-embed → lease reclaim (plan §14)', () => {
  test('an expired lease is reclaimed with a fresh token + generation; the late worker cannot activate and cleans only its own generation', async () => {
    await seedQueued({ asset_id: 'dead-1' });

    // Worker A claims with a short lease and "dies" (no further progress).
    const staleClaim = await db.claimNextDue({ workerId: 'wA', leaseMs: 1_000 });
    expect(staleClaim.target_generation).toBe(1);

    // Past the lease: worker B reclaims — new token, incremented generation.
    const future = new Date(Date.now() + 5_000);
    const reclaim = await db.claimNextDue({ workerId: 'wB', leaseMs: 60_000, now: future });
    expect(reclaim).not.toBeNull();
    expect(reclaim.target_generation).toBe(2);
    expect(reclaim.execution_token).not.toBe(staleClaim.execution_token);

    // B completes normally.
    const rag = createFakeRag();
    const worker = buildWorker({ ragClient: rag, workerId: 'wB' });
    const resultB = await worker.executeClaim(reclaim);
    expect(resultB.outcome).toBe('ready');
    expect((await db.getAssetByAssetId('dead-1')).active_generation).toBe(2);

    // A comes back late: activation CAS-misses on the stale token, and only
    // generation 1 — A's own staging data — is deleted. Generation 2 stays.
    const lateResult = await buildWorker({ ragClient: rag, workerId: 'wA' }).executeClaim(
      staleClaim,
    );
    expect(lateResult.outcome).toBe('activation_miss');
    expect(rag.deleted).toEqual(['dead-1:1']);
    const asset = await db.getAssetByAssetId('dead-1');
    expect(asset.status).toBe('ready');
    expect(asset.active_generation).toBe(2);
  });
});

// KK20-195 review F8 (re-review) — the three residual generation-leak paths.
describe('F8 — generation-leak paths', () => {
  test('a false debt write (asset row absent) alerts instead of silently losing the generation', async () => {
    await seedQueued({ asset_id: 'debt-absent' });
    const rag = {
      async embedGeneration() {
        throw httpError(503); // retryable → cleanup runs
      },
      async deleteGeneration() {
        throw new Error('rag down'); // …and the cleanup itself fails → record debt
      },
    };
    // The row is gone by the time the debt write runs (matchedCount 0 → false):
    // the generation is orphaned with no ledger entry, which MUST alert.
    const dbRowGone = { ...db, recordStaleGeneration: async () => false };
    const worker = buildWorker({ ragClient: rag, db: dbRowGone });

    await worker.processNextDue();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[alert][cleanup_debt_unrecorded]'),
    );
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('asset row absent'));
  });

  test('activation throwing after a successful embed cleans the written generation and rethrows', async () => {
    await seedQueued({ asset_id: 'act-throw' });
    const rag = createFakeRag();
    const boom = new Error('mongo unavailable at activation');
    const dbThrows = {
      ...db,
      activateGeneration: async () => {
        throw boom;
      },
    };
    const claim = await dbThrows.claimNextDue({ workerId: 'w-at', leaseMs: 60_000 });
    const worker = buildWorker({ ragClient: rag, db: dbThrows, workerId: 'w-at' });

    // The error propagates (lease-expiry reclaim handles the retry)…
    await expect(worker.executeClaim(claim)).rejects.toThrow('mongo unavailable at activation');
    // …but only AFTER the written generation is cleaned — no orphaned vectors.
    expect(rag.written).toEqual(['act-throw:1']);
    expect(rag.deleted).toEqual(['act-throw:1']);
  });
});

describe('retry classification (§5.3)', () => {
  // KK20-195 review R9 — a failed generation cleanup becomes persisted DEBT.
  test('a failed generation cleanup is recorded as stale_generations debt (R9)', async () => {
    await seedQueued({ asset_id: 'debt-w1' });
    const rag = {
      async embedGeneration() {
        throw httpError(503); // retryable embed failure → cleanup runs
      },
      async deleteGeneration() {
        throw new Error('rag down'); // …and the cleanup itself fails
      },
    };
    const worker = buildWorker({ ragClient: rag });

    const { outcome } = await worker.processNextDue();

    expect(outcome).toBe('requeued');
    const asset = await db.getAssetByAssetId('debt-w1');
    expect(asset.stale_generations).toEqual([1]); // the debt survives the requeue
  });

  test('retryable failure → requeued with future next_attempt_at; its generation cleaned', async () => {
    await seedQueued({ asset_id: 'r1' });
    const rag = createFakeRag();
    rag.failWith(httpError(503));
    const worker = buildWorker({ ragClient: rag });

    const { outcome } = await worker.processNextDue();

    expect(outcome).toBe('requeued');
    const asset = await db.getAssetByAssetId('r1');
    expect(asset.status).toBe('queued');
    expect(asset.last_error_code).toBe('embed_retryable');
    expect(asset.next_attempt_at.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(asset.execution_token).toBeUndefined(); // fenced transition cleared the lease
    expect(rag.deleted).toEqual(['r1:1']); // failed attempt's staging data removed
  });

  test('permanent input failure → failed, never retried', async () => {
    await seedQueued({ asset_id: 'p1' });
    const rag = createFakeRag();
    rag.failWith(httpError(415));
    const worker = buildWorker({ ragClient: rag });

    const { outcome } = await worker.processNextDue();

    expect(outcome).toBe('failed');
    const asset = await db.getAssetByAssetId('p1');
    expect(asset.status).toBe('failed');
    expect(asset.last_error_code).toBe('embed_permanent');
  });

  test('attempt cap exhausts a retryable failure into failed', async () => {
    process.env.KNAUF_WORKER_ATTEMPT_CAP = '1';
    try {
      await seedQueued({ asset_id: 'x1' });
      const rag = createFakeRag();
      rag.failWith(httpError(503));
      const worker = buildWorker({ ragClient: rag });

      const { outcome } = await worker.processNextDue();

      expect(outcome).toBe('failed');
      expect((await db.getAssetByAssetId('x1')).last_error_code).toBe('embed_attempts_exhausted');
    } finally {
      delete process.env.KNAUF_WORKER_ATTEMPT_CAP;
    }
  });

  test('auth/config failure alerts and fails after its limited cap', async () => {
    process.env.KNAUF_WORKER_AUTH_ATTEMPT_CAP = '1';
    try {
      await seedQueued({ asset_id: 'auth-1' });
      const rag = createFakeRag();
      rag.failWith(httpError(401));
      const worker = buildWorker({ ragClient: rag });

      const { outcome } = await worker.processNextDue();

      expect(outcome).toBe('failed');
      expect((await db.getAssetByAssetId('auth-1')).last_error_code).toBe('embed_auth_config');
      expect(logger.error).toHaveBeenCalled(); // immediate alert-level log
    } finally {
      delete process.env.KNAUF_WORKER_AUTH_ATTEMPT_CAP;
    }
  });

  test('unresolvable scope below the attempt cap → requeued (createFile-race grace), no RAG call', async () => {
    // KK20-195 review — a null scope is usually the brief window between
    // markQueued and the File-row insert, not a true orphan. Requeue, don't fail.
    await seedQueued({ asset_id: 'ns-1' });
    const rag = createFakeRag();
    const worker = createIndexingWorker({
      db,
      ragClient: rag,
      resolveScope: async () => null,
      markFilesEmbedded: jest.fn(),
      logger,
      workerId: 'w1',
    });

    const { outcome } = await worker.processNextDue();

    expect(outcome).toBe('requeued');
    expect(rag.written).toEqual([]);
    expect((await db.getAssetByAssetId('ns-1')).status).toBe('queued');
  });

  test('unresolvable scope at the attempt cap → failed scope_unresolved', async () => {
    // attempt_count seeded at the default cap (5); the claim increments it past
    // the cap, so the grace window is exhausted and the asset is failed.
    await seedQueued({ asset_id: 'ns-2', attempt_count: 5 });
    const rag = createFakeRag();
    const worker = createIndexingWorker({
      db,
      ragClient: rag,
      resolveScope: async () => null,
      markFilesEmbedded: jest.fn(),
      logger,
      workerId: 'w1',
    });

    const { outcome } = await worker.processNextDue();

    expect(outcome).toBe('failed');
    expect(rag.written).toEqual([]);
    expect((await db.getAssetByAssetId('ns-2')).last_error_code).toBe('scope_unresolved');
  });

  test('a persistent File.embedded lockstep failure still returns ready and alerts', async () => {
    // The asset IS ready; a failed embedded flip would silently drop it from
    // file_search (getToolFilesByIds filters embedded:true) — retry then alert.
    await seedQueued({ asset_id: 'lk1' });
    const rag = createFakeRag();
    const markFilesEmbedded = jest.fn().mockRejectedValue(new Error('mongo down'));
    const worker = createIndexingWorker({
      db,
      ragClient: rag,
      resolveScope: async () => ({ userId: 'u1', entityId: 'u1' }),
      markFilesEmbedded,
      logger,
      workerId: 'w1',
    });

    const { outcome } = await worker.processNextDue();

    expect(outcome).toBe('ready');
    expect(markFilesEmbedded).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[alert][embedded_lockstep_failed]'),
    );
  });
});

describe('tombstone mid-processing (plan §14 delete-while-processing)', () => {
  test('a tombstone landing after the claim stops execution before RAG', async () => {
    await seedQueued({ asset_id: 't1' });
    const claim = await db.claimNextDue({ workerId: 'w1', leaseMs: 60_000 });
    await db.tombstoneForDelete({ asset_id: 't1' });

    const rag = createFakeRag();
    const worker = buildWorker({ ragClient: rag });
    const result = await worker.executeClaim(claim);

    expect(result.outcome).toBe('delete_requested');
    expect(rag.written).toEqual([]); // no wasted RAG work
    expect((await db.getAssetByAssetId('t1')).status).toBe('deleting'); // untouched by the worker
  });
});

describe('SIGTERM semantics — stop() halts claiming (§5.2)', () => {
  test('a stopped loop exits without claiming queued work', async () => {
    await seedQueued({ asset_id: 'stop-1' });
    const rag = createFakeRag();
    const worker = buildWorker({ ragClient: rag });

    worker.stop();
    await worker.start(); // resolves immediately — no claim happens

    expect(rag.written).toEqual([]);
    expect((await db.getAssetByAssetId('stop-1')).status).toBe('queued');
  });
});

// KK20-195 review R11 — loop liveness + claim-outcome recording for /ready
// and the knauf_file_index_worker_claims_total counter.
describe('R11 — loop liveness + claim-outcome recorder', () => {
  test('getLastProgressAt advances when the loop runs; outcomes are recorded', async () => {
    await seedQueued({ asset_id: 'tick-1' });
    const recordClaimOutcome = jest.fn();
    const worker = buildWorker({ recordClaimOutcome });
    const before = worker.getLastProgressAt();

    await new Promise((resolve) => setTimeout(resolve, 5));
    const loop = worker.start();
    await new Promise((resolve) => setTimeout(resolve, 50)); // one iteration lands
    worker.stop();
    await loop;

    expect(worker.getLastProgressAt()).toBeGreaterThan(before);
    expect(recordClaimOutcome).toHaveBeenCalledWith('ready'); // idle ticks not recorded
  });

  // KK20-195 re-review R11 — a valid long claim keeps /ready green: the
  // heartbeat advances getLastProgressAt even while the loop is blocked in the
  // embed await (previously only the pre-await tick counted, so a >25s job
  // flipped /ready to 503).
  test('a live heartbeat during a long claim advances getLastProgressAt', async () => {
    await seedQueued({ asset_id: 'slow-1' });
    let releaseEmbed;
    const rag = createFakeRag();
    rag.embedGeneration = () =>
      new Promise((resolve) => {
        releaseEmbed = () => resolve({ status: 'ready' });
      });
    // Heartbeat every 20ms so it fires while the embed is parked.
    process.env.KNAUF_WORKER_HEARTBEAT_MS = '20';
    try {
      const worker = buildWorker({ ragClient: rag });
      const claim = await db.claimNextDue({ workerId: 'w-slow', leaseMs: 60_000 });
      const exec = worker.executeClaim(claim);
      const beforeHeartbeat = worker.getLastProgressAt();
      await new Promise((resolve) => setTimeout(resolve, 70)); // let heartbeats fire
      expect(worker.getLastProgressAt()).toBeGreaterThan(beforeHeartbeat);
      releaseEmbed();
      await exec;
    } finally {
      delete process.env.KNAUF_WORKER_HEARTBEAT_MS;
    }
  });
});

describe('helpers', () => {
  test.each([
    [httpError(429), 'retryable'],
    [httpError(503), 'retryable'],
    [httpError(408), 'retryable'],
    [Object.assign(new Error('reset'), { code: 'ECONNRESET' }), 'retryable'],
    [new Error('unknown'), 'retryable'],
    [httpError(401), 'auth'],
    [httpError(403), 'auth'],
    [httpError(415), 'permanent'],
    [httpError(422), 'permanent'],
  ])('classifyWorkerError(%o) → %s', (error, expected) => {
    expect(classifyWorkerError(error)).toBe(expected);
  });

  test('computeNextAttemptAt honors Retry-After as the floor and caps the exponential', () => {
    const now = new Date('2026-07-16T00:00:00Z');
    const withRetryAfter = computeNextAttemptAt({
      attempt: 1,
      retryAfter: 30_000,
      baseMs: 1_000,
      maxMs: 60_000,
      now,
    });
    expect(withRetryAfter.getTime() - now.getTime()).toBeGreaterThanOrEqual(30_000);

    for (let attempt = 1; attempt <= 12; attempt++) {
      const next = computeNextAttemptAt({ attempt, baseMs: 1_000, maxMs: 5_000, now });
      expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(30_000 + 5_000);
    }
  });

  test('computeNextAttemptAt caps a hostile Retry-After at maxMs (no day-long park)', () => {
    const now = new Date('2026-07-16T00:00:00Z');
    const next = computeNextAttemptAt({
      attempt: 1,
      retryAfter: 86_400_000, // a bogus 24h Retry-After
      baseMs: 1_000,
      maxMs: 60_000,
      now,
    });
    expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(60_000);
  });

  // KK20-195 review F8 (re-review) — generation 0 (the sync/migration label) is
  // a REAL generation and must be cleaned; only null (never written) is dropped.
  test('generationsToClean keeps generation 0, drops null, dedupes', () => {
    expect(
      generationsToClean({ active_generation: 0, target_generation: 0, stale_generations: [] }),
    ).toEqual([0]);
    expect(
      generationsToClean({ active_generation: 2, target_generation: 3, stale_generations: [1, 2] }),
    ).toEqual([2, 3, 1]);
    // never-activated: active null, target defaults to 0 — a gen-0 delete here is
    // an idempotent no-op, so it's harmless to include.
    expect(
      generationsToClean({ active_generation: null, target_generation: 0, stale_generations: [] }),
    ).toEqual([0]);
    // a missing stale_generations array is tolerated.
    expect(generationsToClean({ active_generation: null, target_generation: 5 })).toEqual([5]);
  });
});
// End [knauf]
