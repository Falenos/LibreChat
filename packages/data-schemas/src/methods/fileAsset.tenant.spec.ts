// [knauf] KK20-195 review R1 — tenant isolation for the FileAsset aggregate,
// exercised through the ACTUAL model factory (createModels →
// applyTenantIsolation) and the AsyncLocalStorage tenant context — not the
// raw schema. This is the reproduction path from the PR #143 review: before
// the schema gained a `tenantId` path, the plugin's where-injection made the
// reservation upsert throw StrictModeError for every tenant-aware request,
// flags on or off.
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { _resetStrictCache } from '~/models/plugins/tenantIsolation';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createFileAssetMethods } from '~/methods/fileAsset';
import { createModels } from '~/models';

let mongoServer: MongoMemoryServer;
let db: ReturnType<typeof createFileAssetMethods>;

const reserveParams = (overrides: Record<string, unknown> = {}) => ({
  asset_id: (overrides.asset_id as string) ?? 'a1',
  scope_type: 'user' as const,
  scope_id: 'u1',
  target_index_profile: 'legacy-v0',
  vector_backend: 'pgvector' as const,
  embed_route: '/embed' as const,
  content_hash: 'h1',
  ...overrides,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  createModels(mongoose); // the REAL factory — applies applyTenantIsolation
  db = createFileAssetMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
  await mongoose.models.KnaufFileAsset.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await runAsSystem(async () => {
    await mongoose.models.KnaufFileAsset.deleteMany({});
  });
  delete process.env.TENANT_ISOLATION_STRICT;
  _resetStrictCache();
});

describe('FileAsset tenant isolation (KK20-195 review R1)', () => {
  test('a tenant-aware reservation succeeds and persists the tenant (was StrictModeError)', async () => {
    const result = await tenantStorage.run({ tenantId: 't1' }, async () =>
      db.reserveAsset(reserveParams({ asset_id: 'ta-1', dedup_key: 'u:u1:h:h1' })),
    );
    expect(result.created).toBe(true);

    const raw = await runAsSystem(async () =>
      mongoose.models.KnaufFileAsset.findOne({ asset_id: 'ta-1' }).lean<{ tenantId?: string }>(),
    );
    expect(raw?.tenantId).toBe('t1');
  });

  test('dedup keys never coalesce across tenants (tenant-scoped uniqueness)', async () => {
    const first = await tenantStorage.run({ tenantId: 't1' }, async () =>
      db.reserveAsset(reserveParams({ asset_id: 'dk-1', dedup_key: 'u:u1:h:h1' })),
    );
    const firstRaw = await runAsSystem(async () =>
      mongoose.models.KnaufFileAsset.findOne({ asset_id: 'dk-1' }).lean<{ tenantId?: string }>(),
    );
    expect(firstRaw?.tenantId).toBe('t1');
    const second = await tenantStorage.run({ tenantId: 't2' }, async () =>
      db.reserveAsset(reserveParams({ asset_id: 'dk-2', dedup_key: 'u:u1:h:h1' })),
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(true); // same dedup_key, DIFFERENT tenant → separate asset
    expect(second.asset.asset_id).toBe('dk-2');

    // Within one tenant the dedup key still coalesces.
    const replay = await tenantStorage.run({ tenantId: 't1' }, async () =>
      db.reserveAsset(reserveParams({ asset_id: 'dk-3', dedup_key: 'u:u1:h:h1' })),
    );
    expect(replay.created).toBe(false);
    expect(replay.asset.asset_id).toBe('dk-1');
  });

  test('cross-tenant reads are isolated; the system context (worker) sees everything', async () => {
    await tenantStorage.run({ tenantId: 't1' }, async () =>
      db.reserveAsset(reserveParams({ asset_id: 'iso-1' })),
    );

    const foreign = await tenantStorage.run({ tenantId: 't2' }, async () =>
      db.getAssetByAssetId('iso-1'),
    );
    expect(foreign).toBeNull();

    const system = await runAsSystem(async () => db.getAssetByAssetId('iso-1'));
    expect(system).not.toBeNull();
  });

  test('the worker claim path (runAsSystem) claims tenant-owned queued work', async () => {
    await tenantStorage.run({ tenantId: 't1' }, async () => {
      const { asset } = await db.reserveAsset(reserveParams({ asset_id: 'claim-1' }));
      await db.markQueued({ asset_id: asset.asset_id, blob: { path: '/p', bytes: 5 } });
    });

    const claim = await runAsSystem(async () =>
      db.claimNextDue({ workerId: 'w1', leaseMs: 60_000 }),
    );
    expect(claim?.asset_id).toBe('claim-1');
    expect(claim?.tenantId).toBe('t1'); // persisted scope travels with the claim
  });

  test('strict mode fails closed without tenant context', async () => {
    process.env.TENANT_ISOLATION_STRICT = 'true';
    _resetStrictCache();
    await expect(db.reserveAsset(reserveParams({ asset_id: 'strict-1' }))).rejects.toThrow(
      /tenant context/i,
    );
  });
});
// End [knauf]
