// [knauf] KK20-328 — the ledger against a real Mongo, including the contracts the
// review demanded: crash between delete and commit, partial delete, full expiry
// with a terminal checkpoint + generation, concurrent first-commit races, lease
// contention, and signatures.
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { RecordAuditEntryInput } from '~/types';
import type * as t from '~/types';
import {
  AUDIT_RETENTION_SWEEP_LEASE,
  auditRetentionScopeKey,
  createAuditRetentionCheckpointMethods,
} from './methods';
import { createAuditRetentionCheckpointModel, createAuditRetentionLeaseModel } from './model';
import { signAuditCheckpoint, verifyAuditCheckpointSignature } from './signature';
import { createAuditLogMethods } from '~/methods/auditLog';
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
let Lease: mongoose.Model<t.IKnaufAuditRetentionLease>;
let audit: ReturnType<typeof createAuditLogMethods>;
let ledger: ReturnType<typeof createAuditRetentionCheckpointMethods>;

const TENANT = 'tenant-a';
const SCOPE = auditRetentionScopeKey(TENANT);
const NOW = () => new Date();
const FUTURE = () => new Date(Date.now() + 60_000);

function entry(i: number): RecordAuditEntryInput {
  return {
    action: 'grant.assigned',
    actor: { type: 'user', id: new Types.ObjectId(), name: 'Alice Admin' },
    target: { type: 'role', id: 'ADMIN', name: 'ADMIN' },
    metadata: { capability: `cap:${i}` },
    tenantId: TENANT,
  };
}

async function seed(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await audit.recordAuditEntry(entry(i));
}

async function createdAtOfSeq(seq: number): Promise<Date> {
  const doc = await AuditLog.findOne({ seq }).lean<{ createdAt: Date }>();
  return doc!.createdAt;
}

/** The full sweep step for one scope: announce, delete (upstream), finalize. */
async function purgeThrough(before: Date, signingKey?: string) {
  const boundary = await ledger.computeAuditRetentionBoundary(TENANT, before);
  if (!boundary) return { boundary, purge: { deletedCount: 0 }, outcome: undefined };
  await ledger.beginAuditRetentionPurge({ scopeKey: SCOPE, boundary, cutoff: before, now: NOW() });
  const purge = await audit.purgeAuditLogEntries(TENANT, { before, confirm: true });
  const outcome = await ledger.finalizeAuditRetentionPurge({
    scopeKey: SCOPE,
    tenantId: TENANT,
    deletedCount: purge.deletedCount,
    now: NOW(),
    signingKey,
  });
  return { boundary, purge, outcome };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  AuditLog = mongoose.models.AuditLog || mongoose.model<t.IAuditLog>('AuditLog', auditLogSchema);
  Checkpoint = createAuditRetentionCheckpointModel(mongoose);
  Lease = createAuditRetentionLeaseModel(mongoose);
  audit = createAuditLogMethods(mongoose);
  ledger = createAuditRetentionCheckpointMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
  await AuditLog.init();
  await Checkpoint.init();
  await Lease.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await AuditLog.collection.deleteMany({}); // raw driver: the model is append-only
  await Checkpoint.deleteMany({});
  await Lease.deleteMany({});
});

describe('auditRetentionScopeKey', () => {
  it('namespaces tenants so one named __platform__ cannot collide with the sentinel', () => {
    expect(auditRetentionScopeKey('__platform__')).not.toBe(auditRetentionScopeKey(undefined));
    expect(auditRetentionScopeKey('  ')).toBe(auditRetentionScopeKey(undefined));
  });
});

describe('boundary mirrors the upstream purge', () => {
  it('computes the same prefix upstream deletes, and null when nothing is purgeable', async () => {
    await seed(6);
    const before = await createdAtOfSeq(4);
    const boundary = await ledger.computeAuditRetentionBoundary(TENANT, before);
    expect(boundary).toEqual(expect.objectContaining({ throughSeq: 3, terminal: false }));
    const purge = await audit.purgeAuditLogEntries(TENANT, { before, confirm: true });
    expect(purge.checkpoint).toEqual({
      throughSeq: boundary!.throughSeq,
      prevHash: boundary!.prevHash,
    });
    expect(await ledger.computeAuditRetentionBoundary(TENANT, new Date(0))).toBeNull();
  });

  it('a cutoff past the tail is a TERMINAL boundary ending on the last hash', async () => {
    await seed(3);
    const last = await AuditLog.findOne({ seq: 3 }).lean<{ hash: string }>();
    expect(await ledger.computeAuditRetentionBoundary(TENANT, FUTURE())).toEqual({
      throughSeq: 3,
      prevHash: last!.hash,
      terminal: true,
    });
  });
});

describe('purge → commit → verify', () => {
  it('verification FAILS without the checkpoint and PASSES with it', async () => {
    await seed(6);
    const { outcome } = await purgeThrough(await createdAtOfSeq(4));
    expect(outcome).toEqual(expect.objectContaining({ action: 'committed', generation: 1 }));
    expect((await audit.verifyAuditChain(TENANT)).ok).toBe(false);
    const state = await ledger.getAuditRetentionCheckpoint(SCOPE);
    const ok = await audit.verifyAuditChain(TENANT, {
      trustedCheckpoint: { throughSeq: state!.throughSeq, prevHash: state!.prevHash },
    });
    expect(ok.ok).toBe(true);
    expect(state!.pending).toBeNull();
    expect(state!.totalDeleted).toBe(3);
  });

  it('a second purge advances within the same generation', async () => {
    await seed(8);
    await purgeThrough(await createdAtOfSeq(3));
    const { outcome } = await purgeThrough(await createdAtOfSeq(6));
    expect(outcome).toEqual(expect.objectContaining({ action: 'committed', generation: 1 }));
    expect((await ledger.getAuditRetentionCheckpoint(SCOPE))!.throughSeq).toBe(5);
  });
});

describe('crash recovery — the chain is the source of truth', () => {
  it('delete happened, commit never ran ⇒ finalize on the next pass commits it as recovered', async () => {
    await seed(6);
    const before = await createdAtOfSeq(4);
    const boundary = await ledger.computeAuditRetentionBoundary(TENANT, before);
    await ledger.beginAuditRetentionPurge({
      scopeKey: SCOPE,
      boundary: boundary!,
      cutoff: before,
      now: NOW(),
    });
    await audit.purgeAuditLogEntries(TENANT, { before, confirm: true });
    // ...process dies here. Next sweep:
    const outcome = await ledger.finalizeAuditRetentionPurge({
      scopeKey: SCOPE,
      tenantId: TENANT,
      now: NOW(),
      recovered: true,
    });
    expect(outcome).toEqual({
      action: 'committed',
      boundary: expect.objectContaining({ throughSeq: 3 }),
      generation: 1,
      recovered: true,
    });
    const state = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect(state!.recoveredCommits).toBe(1);
    expect((await audit.verifyAuditChain(TENANT, { trustedCheckpoint: state })).ok).toBe(true);
  });

  it('delete never happened ⇒ the intent is dropped, nothing is legitimized', async () => {
    await seed(6);
    const before = await createdAtOfSeq(4);
    const boundary = await ledger.computeAuditRetentionBoundary(TENANT, before);
    await ledger.beginAuditRetentionPurge({
      scopeKey: SCOPE,
      boundary: boundary!,
      cutoff: before,
      now: NOW(),
    });
    const outcome = await ledger.finalizeAuditRetentionPurge({
      scopeKey: SCOPE,
      tenantId: TENANT,
      now: NOW(),
    });
    expect(outcome).toEqual({ action: 'dropped', reason: 'nothing-deleted' });
    expect(await ledger.getAuditRetentionCheckpoint(SCOPE)).toEqual(
      expect.objectContaining({ throughSeq: 0, pending: null }),
    );
  });

  it('PARTIAL delete (crash mid-deleteMany) ⇒ commits the boundary the chain actually has, inside the intent', async () => {
    await seed(6);
    const before = await createdAtOfSeq(5); // intent: through seq 4
    const boundary = await ledger.computeAuditRetentionBoundary(TENANT, before);
    await ledger.beginAuditRetentionPurge({
      scopeKey: SCOPE,
      boundary: boundary!,
      cutoff: before,
      now: NOW(),
    });
    await AuditLog.collection.deleteMany({ seq: { $lte: 2 } }); // only part of the prefix went
    const outcome = await ledger.finalizeAuditRetentionPurge({
      scopeKey: SCOPE,
      tenantId: TENANT,
      now: NOW(),
    });
    expect(outcome).toEqual(
      expect.objectContaining({
        action: 'committed',
        boundary: expect.objectContaining({ throughSeq: 2 }),
      }),
    );
    const state = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect((await audit.verifyAuditChain(TENANT, { trustedCheckpoint: state })).ok).toBe(true);
  });

  it('deletion BEYOND the intent is never legitimized', async () => {
    await seed(6);
    const before = await createdAtOfSeq(3); // intent: through seq 2
    const boundary = await ledger.computeAuditRetentionBoundary(TENANT, before);
    await ledger.beginAuditRetentionPurge({
      scopeKey: SCOPE,
      boundary: boundary!,
      cutoff: before,
      now: NOW(),
    });
    await AuditLog.collection.deleteMany({ seq: { $lte: 4 } }); // an attacker took more
    const outcome = await ledger.finalizeAuditRetentionPurge({
      scopeKey: SCOPE,
      tenantId: TENANT,
      now: NOW(),
    });
    expect(outcome).toEqual({ action: 'dropped', reason: 'boundary-outside-intent' });
    expect((await audit.verifyAuditChain(TENANT)).ok).toBe(false);
  });
});

describe('full expiry — terminal checkpoint and generations', () => {
  it('an emptied chain keeps a TERMINAL checkpoint instead of losing its history', async () => {
    await seed(3);
    const { outcome } = await purgeThrough(FUTURE());
    expect(outcome).toEqual(
      expect.objectContaining({
        action: 'committed',
        boundary: expect.objectContaining({ terminal: true, throughSeq: 3 }),
      }),
    );
    const state = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect(state).toEqual(
      expect.objectContaining({ terminal: true, generation: 1, throughSeq: 3 }),
    );
    // Distinguishable: an empty chain WITH a terminal checkpoint is authorized expiry.
    expect(await AuditLog.countDocuments({})).toBe(0);
  });

  it('the restarted chain verifies, and the next purge opens generation 2 — no wedge', async () => {
    await seed(3);
    await purgeThrough(FUTURE());
    await seed(5); // upstream restarts at seq 1 from genesis
    expect((await AuditLog.findOne({}).sort({ seq: 1 }).lean<{ seq: number }>())!.seq).toBe(1);
    let state = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect((await audit.verifyAuditChain(TENANT, { trustedCheckpoint: state })).ok).toBe(true);

    const { outcome } = await purgeThrough(await createdAtOfSeq(3));
    expect(outcome).toEqual(
      expect.objectContaining({
        action: 'committed',
        generation: 2,
        boundary: expect.objectContaining({ throughSeq: 2, terminal: false }),
      }),
    );
    state = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect(state).toEqual(
      expect.objectContaining({ generation: 2, throughSeq: 2, terminal: false }),
    );
    expect((await audit.verifyAuditChain(TENANT, { trustedCheckpoint: state })).ok).toBe(true);
  });

  it('terminal purge, crash, chain already restarted ⇒ recovery still commits the terminal boundary', async () => {
    await seed(3);
    const boundary = await ledger.computeAuditRetentionBoundary(TENANT, FUTURE());
    await ledger.beginAuditRetentionPurge({
      scopeKey: SCOPE,
      boundary: boundary!,
      cutoff: FUTURE(),
      now: NOW(),
    });
    await audit.purgeAuditLogEntries(TENANT, { before: FUTURE(), confirm: true });
    await seed(2); // new entries before the next sweep
    const outcome = await ledger.finalizeAuditRetentionPurge({
      scopeKey: SCOPE,
      tenantId: TENANT,
      now: NOW(),
      recovered: true,
    });
    expect(outcome).toEqual(
      expect.objectContaining({
        action: 'committed',
        boundary: expect.objectContaining({ terminal: true, throughSeq: 3 }),
        recovered: true,
      }),
    );
  });
});

describe('concurrency', () => {
  it('first begin+finalize under contention: exactly one document, highest valid boundary wins, no lost update', async () => {
    await seed(6);
    const before = await createdAtOfSeq(4);
    const boundary = await ledger.computeAuditRetentionBoundary(TENANT, before);
    await Promise.all(
      Array.from({ length: 12 }, () =>
        ledger.beginAuditRetentionPurge({
          scopeKey: SCOPE,
          boundary: boundary!,
          cutoff: before,
          now: NOW(),
        }),
      ),
    );
    expect(await Checkpoint.countDocuments({ scopeKey: SCOPE })).toBe(1);
    await audit.purgeAuditLogEntries(TENANT, { before, confirm: true });
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () =>
        ledger.finalizeAuditRetentionPurge({
          scopeKey: SCOPE,
          tenantId: TENANT,
          deletedCount: 3,
          now: NOW(),
        }),
      ),
    );
    expect(outcomes.filter((o) => o.action === 'committed')).toHaveLength(1);
    const state = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect(state).toEqual(expect.objectContaining({ throughSeq: 3, totalDeleted: 3 }));
    expect(await Checkpoint.countDocuments({ scopeKey: SCOPE })).toBe(1);
  });

  it('lease: one owner wins, the other is refused, renewal is owner-scoped, expiry allows takeover, release frees it', async () => {
    const t0 = new Date();
    expect(await ledger.acquireAuditRetentionLease({ owner: 'a', ttlMs: 60_000, now: t0 })).toBe(
      true,
    );
    expect(await ledger.acquireAuditRetentionLease({ owner: 'b', ttlMs: 60_000, now: t0 })).toBe(
      false,
    );
    expect(await ledger.acquireAuditRetentionLease({ owner: 'a', ttlMs: 60_000, now: t0 })).toBe(
      true,
    ); // re-entrant
    expect(await ledger.renewAuditRetentionLease({ owner: 'b', ttlMs: 60_000, now: t0 })).toBe(
      false,
    );
    expect(await ledger.renewAuditRetentionLease({ owner: 'a', ttlMs: 60_000, now: t0 })).toBe(
      true,
    );
    const later = new Date(t0.getTime() + 61_000);
    expect(await ledger.acquireAuditRetentionLease({ owner: 'b', ttlMs: 60_000, now: later })).toBe(
      true,
    );
    expect((await Lease.findOne({ name: AUDIT_RETENTION_SWEEP_LEASE }).lean())!.owner).toBe('b');
    await ledger.releaseAuditRetentionLease({ owner: 'a' }); // not the owner: no-op
    expect(await Lease.countDocuments({})).toBe(1);
    await ledger.releaseAuditRetentionLease({ owner: 'b' });
    expect(await Lease.countDocuments({})).toBe(0);
  });

  it('lease: a burst of contenders yields exactly one holder', async () => {
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        ledger.acquireAuditRetentionLease({ owner: `w${i}`, ttlMs: 60_000, now }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('signature', () => {
  it('commit signs when a key is given; verification detects a tampered boundary', async () => {
    await seed(6);
    const { outcome } = await purgeThrough(await createdAtOfSeq(4), 'k1');
    expect(outcome!.action).toBe('committed');
    const state = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect(verifyAuditCheckpointSignature(state!, 'k1')).toBe('valid');
    expect(verifyAuditCheckpointSignature(state!, 'other')).toBe('invalid');
    expect(verifyAuditCheckpointSignature(state!, undefined)).toBe('unsigned');
    // Someone with only the Mongo credential moves the boundary to hide a deletion:
    await Checkpoint.updateOne({ scopeKey: SCOPE }, { $set: { throughSeq: 5 } });
    const tampered = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect(verifyAuditCheckpointSignature(tampered!, 'k1')).toBe('invalid');
    expect(signAuditCheckpoint(state!, 'k1')).toBe(state!.signature);
  });

  it('unsigned commits report unsigned, and a configured key flags them invalid', async () => {
    await seed(4);
    await purgeThrough(await createdAtOfSeq(3));
    const state = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect(state!.signature).toBeUndefined();
    expect(verifyAuditCheckpointSignature(state!, undefined)).toBe('unsigned');
    expect(verifyAuditCheckpointSignature(state!, 'k1')).toBe('invalid');
  });
});
// End [knauf]
