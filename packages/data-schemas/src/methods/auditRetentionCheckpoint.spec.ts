// [knauf] KK20-328 — the checkpoint ledger against a real Mongo, including the
// end-to-end contract that matters: purge → persist → verifyAuditChain passes.
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { RecordAuditEntryInput } from '~/types';
import type * as t from '~/types';
import {
  auditRetentionScopeKey,
  createAuditRetentionCheckpointMethods,
} from './auditRetentionCheckpoint';
import auditRetentionCheckpointSchema from '~/schema/auditRetentionCheckpoint';
import { createAuditLogMethods } from './auditLog';
import auditLogSchema from '~/schema/auditLog';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let AuditLog: mongoose.Model<t.IAuditLog>;
let Checkpoint: mongoose.Model<t.IKnaufAuditRetentionCheckpoint>;
let audit: ReturnType<typeof createAuditLogMethods>;
let ledger: ReturnType<typeof createAuditRetentionCheckpointMethods>;

const TENANT = 'tenant-a';
const SCOPE = auditRetentionScopeKey(TENANT);

function entry(i: number): RecordAuditEntryInput {
  return {
    action: 'grant.assigned',
    actor: { type: 'user', id: new Types.ObjectId(), name: 'Alice Admin' },
    target: { type: 'role', id: 'ADMIN', name: 'ADMIN' },
    metadata: { capability: `cap:${i}` },
    tenantId: TENANT,
  };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  AuditLog = mongoose.models.AuditLog || mongoose.model<t.IAuditLog>('AuditLog', auditLogSchema);
  Checkpoint =
    mongoose.models.KnaufAuditRetentionCheckpoint ||
    mongoose.model<t.IKnaufAuditRetentionCheckpoint>(
      'KnaufAuditRetentionCheckpoint',
      auditRetentionCheckpointSchema,
    );
  audit = createAuditLogMethods(mongoose);
  ledger = createAuditRetentionCheckpointMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
  await AuditLog.init();
  await Checkpoint.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await AuditLog.collection.deleteMany({}); // raw driver: the model is append-only
  await Checkpoint.deleteMany({});
});

describe('auditRetentionScopeKey', () => {
  it('namespaces tenants so one named __platform__ cannot collide with the sentinel', () => {
    // Upstream namespaces its chain keys for exactly this reason; storing tenant
    // ids raw would give a tenant literally named __platform__ the platform
    // scope's checkpoint, leaving one of them verifying against the other's chain.
    expect(auditRetentionScopeKey('__platform__')).not.toBe(auditRetentionScopeKey(undefined));
    expect(auditRetentionScopeKey(undefined)).toBe('__platform__');
    expect(auditRetentionScopeKey('   ')).toBe('__platform__');
    expect(auditRetentionScopeKey('a')).not.toBe(auditRetentionScopeKey('b'));
  });
});

describe('advance / get / clear', () => {
  it('creates on first purge and advances forward', async () => {
    await ledger.advanceAuditRetentionCheckpoint({
      scopeKey: SCOPE,
      checkpoint: { throughSeq: 10, prevHash: 'h10' },
      purgedAt: new Date(),
      deletedCount: 10,
    });
    expect(await ledger.getAuditRetentionCheckpoint(SCOPE)).toEqual({
      throughSeq: 10,
      prevHash: 'h10',
    });

    await ledger.advanceAuditRetentionCheckpoint({
      scopeKey: SCOPE,
      checkpoint: { throughSeq: 20, prevHash: 'h20' },
      purgedAt: new Date(),
      deletedCount: 10,
    });
    expect(await ledger.getAuditRetentionCheckpoint(SCOPE)).toEqual({
      throughSeq: 20,
      prevHash: 'h20',
    });
    expect((await Checkpoint.findOne({ scopeKey: SCOPE }).lean())?.totalDeleted).toBe(20);
  });

  it('refuses to move the boundary backwards', async () => {
    // A backwards boundary would stop legitimizing an already-purged prefix and
    // re-break verification, so a stale writer must lose rather than corrupt.
    await ledger.advanceAuditRetentionCheckpoint({
      scopeKey: SCOPE,
      checkpoint: { throughSeq: 50, prevHash: 'h50' },
      purgedAt: new Date(),
      deletedCount: 50,
    });
    await ledger.advanceAuditRetentionCheckpoint({
      scopeKey: SCOPE,
      checkpoint: { throughSeq: 20, prevHash: 'stale' },
      purgedAt: new Date(),
      deletedCount: 5,
    });
    expect(await ledger.getAuditRetentionCheckpoint(SCOPE)).toEqual({
      throughSeq: 50,
      prevHash: 'h50',
    });
  });

  it('returns undefined for a scope that has never been purged, and after clear', async () => {
    expect(await ledger.getAuditRetentionCheckpoint(SCOPE)).toBeUndefined();
    await ledger.advanceAuditRetentionCheckpoint({
      scopeKey: SCOPE,
      checkpoint: { throughSeq: 3, prevHash: 'h3' },
      purgedAt: new Date(),
      deletedCount: 3,
    });
    await ledger.clearAuditRetentionCheckpoint(SCOPE);
    expect(await ledger.getAuditRetentionCheckpoint(SCOPE)).toBeUndefined();
  });
});

describe('end-to-end: purge then verify', () => {
  it('verification FAILS after a purge without the checkpoint, and PASSES with it', async () => {
    // This is the whole reason the ledger exists. Without it the admin
    // chain-verify endpoint reports tampering on every trimmed chain.
    for (let i = 0; i < 6; i++) await audit.recordAuditEntry(entry(i));
    // keep a tail so the chain does not empty: purge only up to the 3rd entry
    const third = await AuditLog.findOne({ seq: 3 }).lean<{ createdAt: Date }>();
    const purge = await audit.purgeAuditLogEntries(TENANT, {
      before: third!.createdAt,
      confirm: true,
    });
    expect(purge.deletedCount).toBeGreaterThan(0);
    expect(purge.checkpoint).toBeDefined();

    const withoutCheckpoint = await audit.verifyAuditChain(TENANT);
    expect(withoutCheckpoint.ok).toBe(false);
    expect(withoutCheckpoint.reason).toContain('prefix purged or deleted');

    await ledger.advanceAuditRetentionCheckpoint({
      scopeKey: SCOPE,
      checkpoint: purge.checkpoint!,
      purgedAt: new Date(),
      deletedCount: purge.deletedCount,
    });

    const trustedCheckpoint = await ledger.getAuditRetentionCheckpoint(SCOPE);
    const withCheckpoint = await audit.verifyAuditChain(TENANT, { trustedCheckpoint });
    expect(withCheckpoint.ok).toBe(true);
  });

  it('an emptied chain restarts at genesis, so a stale boundary must be cleared', async () => {
    for (let i = 0; i < 3; i++) await audit.recordAuditEntry(entry(i));
    const purge = await audit.purgeAuditLogEntries(TENANT, {
      before: new Date(Date.now() + 60_000),
      confirm: true,
    });
    expect(purge.deletedCount).toBe(3);
    expect(purge.checkpoint).toBeUndefined(); // chain emptied

    // New entries restart at seq 1 from GENESIS and verify with no checkpoint...
    await audit.recordAuditEntry(entry(99));
    const first = await AuditLog.findOne({}).lean<{ seq: number }>();
    expect(first?.seq).toBe(1);
    expect((await audit.verifyAuditChain(TENANT)).ok).toBe(true);

    /* The damage from a leftover boundary is deferred, which is what makes it
     * nasty: while the restarted chain still begins at seq 1 the checkpoint is
     * never consulted, so everything looks fine. It breaks at the NEXT purge —
     * the forward-only guard refuses to move a stale far-ahead boundary down to
     * the new (much lower) one, and verification then fails permanently. */
    await ledger.advanceAuditRetentionCheckpoint({
      scopeKey: SCOPE,
      checkpoint: { throughSeq: 999, prevHash: 'stale' },
      purgedAt: new Date(),
      deletedCount: 1,
    });

    for (let i = 0; i < 4; i++) await audit.recordAuditEntry(entry(100 + i));
    const third = await AuditLog.findOne({ seq: 3 }).lean<{ createdAt: Date }>();
    const second = await audit.purgeAuditLogEntries(TENANT, {
      before: third!.createdAt,
      confirm: true,
    });
    expect(second.checkpoint).toBeDefined();

    // The guard refuses the (correct, lower) boundary because the stale one is ahead...
    await ledger.advanceAuditRetentionCheckpoint({
      scopeKey: SCOPE,
      checkpoint: second.checkpoint!,
      purgedAt: new Date(),
      deletedCount: second.deletedCount,
    });
    const wedged = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect(wedged!.throughSeq).toBe(999);
    expect((await audit.verifyAuditChain(TENANT, { trustedCheckpoint: wedged })).ok).toBe(false);

    // ...whereas clearing on the emptying purge (what the sweep does) avoids it entirely.
    await ledger.clearAuditRetentionCheckpoint(SCOPE);
    await ledger.advanceAuditRetentionCheckpoint({
      scopeKey: SCOPE,
      checkpoint: second.checkpoint!,
      purgedAt: new Date(),
      deletedCount: second.deletedCount,
    });
    const healed = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect(healed).toEqual(second.checkpoint);
    expect((await audit.verifyAuditChain(TENANT, { trustedCheckpoint: healed })).ok).toBe(true);
  });
});
// End [knauf]
