// [knauf] KK20-328 — the ledger against a real Mongo, including the contracts three review
// rounds demanded: crash between delete and commit, partial delete, never emptying a chain
// (the newest row is the anchor, so the upstream delete is always bounded), forged /
// unsigned / edited intents under a key (the signing-oracle attack), stale fences and
// competing writers with different boundaries, concurrent appends across phases, lease
// contention/takeover with fence monotonicity, key activation ("missing") and rotation.
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { RecordAuditEntryInput } from '~/types';
import type * as t from '~/types';
import {
  signAuditCheckpoint,
  signAuditIntent,
  verifyAuditCheckpointSignature,
  verifyAuditIntentSignature,
} from './signature';
import {
  AUDIT_RETENTION_SWEEP_LEASE,
  auditRetentionScopeKey,
  createAuditRetentionCheckpointMethods,
} from './methods';
import { createAuditRetentionCheckpointModel, createAuditRetentionLeaseModel } from './model';
import { auditChainKey, createAuditLogMethods } from '~/methods/auditLog';
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
const OWNER = 'host:1';
const KEY = 'k1';
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
  return (await AuditLog.findOne({ seq }).lean<{ createdAt: Date }>())!.createdAt;
}
async function seqs(): Promise<number[]> {
  return (
    await AuditLog.find({}).sort({ seq: 1 }).select('seq').lean<Array<{ seq: number }>>()
  ).map((d) => d.seq);
}
async function begin(before: Date, fence = 1, signingKeys?: string) {
  const boundary = await ledger.computeAuditRetentionBoundary(TENANT, before);
  if (!boundary) return null;
  const ok = await ledger.beginAuditRetentionPurge({
    scopeKey: SCOPE,
    boundary,
    cutoff: before,
    now: NOW(),
    owner: OWNER,
    fence,
    signingKeys,
  });
  return { boundary, ok };
}
function finalize(
  fence = 1,
  extra: {
    deletedCount?: number;
    signingKeys?: string | { current?: string; previous?: string };
    recovered?: boolean;
  } = {},
) {
  return ledger.finalizeAuditRetentionPurge({
    scopeKey: SCOPE,
    tenantId: TENANT,
    fence,
    now: NOW(),
    ...extra,
  });
}
/** The full sweep step for one scope: announce, delete (upstream, bounded by purgeBefore), finalize. */
async function purgeThrough(before: Date, signingKeys?: string, fence = 1) {
  const b = await begin(before, fence, signingKeys);
  if (!b) return { boundary: null, purge: { deletedCount: 0 }, outcome: undefined };
  expect(b.ok).toBe(true);
  const purge = await audit.purgeAuditLogEntries(TENANT, {
    before: b.boundary.purgeBefore,
    confirm: true,
  });
  const outcome = await finalize(fence, { deletedCount: purge.deletedCount, signingKeys });
  return { boundary: b.boundary, purge, outcome };
}
async function verifyWithLedger() {
  const state = await ledger.getAuditRetentionCheckpoint(SCOPE);
  return audit.verifyAuditChain(TENANT, { trustedCheckpoint: state });
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

describe('scope key', () => {
  it("IS upstream's chain key, so ledger and chain partition identically", () => {
    expect(auditRetentionScopeKey(TENANT)).toBe(auditChainKey(TENANT));
    expect(auditRetentionScopeKey(undefined)).toBe(auditChainKey(undefined));
    expect(auditRetentionScopeKey('__platform__')).not.toBe(auditRetentionScopeKey(undefined));
  });
});

describe('boundary — mirrors the upstream purge and never empties the chain', () => {
  it('computes the same prefix upstream deletes, and null when nothing is purgeable', async () => {
    await seed(6);
    const before = await createdAtOfSeq(4);
    const boundary = await ledger.computeAuditRetentionBoundary(TENANT, before);
    expect(boundary).toEqual(expect.objectContaining({ throughSeq: 3, purgeBefore: before }));
    const purge = await audit.purgeAuditLogEntries(TENANT, { before, confirm: true });
    expect(purge.checkpoint).toEqual({ throughSeq: 3, prevHash: boundary!.prevHash });
    expect(await ledger.computeAuditRetentionBoundary(TENANT, new Date(0))).toBeNull();
    expect(await ledger.computeAuditRetentionBoundary(TENANT, before)).toBeNull();
  });

  it('every row older than the cutoff ⇒ retains the NEWEST row and purges through the one before it', async () => {
    await seed(3);
    const boundary = await ledger.computeAuditRetentionBoundary(TENANT, FUTURE());
    expect(boundary).toEqual(expect.objectContaining({ throughSeq: 2 }));
    expect(boundary!.purgeBefore.getTime()).toBe((await createdAtOfSeq(3)).getTime());
    await audit.purgeAuditLogEntries(TENANT, { before: boundary!.purgeBefore, confirm: true });
    expect(await seqs()).toEqual([3]); // the anchor survives
    expect(await ledger.computeAuditRetentionBoundary(TENANT, FUTURE())).toBeNull(); // and is not purgeable
  });

  it('a row appended between announce and delete is safe: the delete is bounded by the retained seq', async () => {
    await seed(3);
    const b = await begin(FUTURE()); // through seq 2, purgeBefore = createdAt(3)
    await seed(1); // seq 4 appended mid-purge (inside retention)
    await audit.purgeAuditLogEntries(TENANT, { before: b!.boundary.purgeBefore, confirm: true });
    expect(await seqs()).toEqual([3, 4]);
    expect(await finalize()).toEqual(
      expect.objectContaining({
        action: 'committed',
        boundary: expect.objectContaining({ throughSeq: 2 }),
      }),
    );
    expect((await verifyWithLedger()).ok).toBe(true);
  });

  it('a single-row chain is never purged', async () => {
    await seed(1);
    expect(await ledger.computeAuditRetentionBoundary(TENANT, FUTURE())).toBeNull();
  });
});

describe('purge → commit → verify', () => {
  it('verification FAILS without the checkpoint and PASSES with it', async () => {
    await seed(6);
    const { outcome } = await purgeThrough(await createdAtOfSeq(4));
    expect(outcome).toEqual(expect.objectContaining({ action: 'committed' }));
    expect((await audit.verifyAuditChain(TENANT)).ok).toBe(false);
    expect((await verifyWithLedger()).ok).toBe(true);
    const state = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect(state).toEqual(
      expect.objectContaining({ pending: null, totalDeleted: 3, lastFence: 1 }),
    );
    expect(state!.purgedAt).toBeInstanceOf(Date);
  });

  it('successive purges advance the boundary; the chain always keeps its anchor', async () => {
    await seed(8);
    await purgeThrough(await createdAtOfSeq(3));
    await purgeThrough(await createdAtOfSeq(6));
    expect((await ledger.getAuditRetentionCheckpoint(SCOPE))!.throughSeq).toBe(5);
    await purgeThrough(FUTURE()); // everything old: retains seq 8
    expect(await seqs()).toEqual([8]);
    expect((await ledger.getAuditRetentionCheckpoint(SCOPE))!.throughSeq).toBe(7);
    expect((await verifyWithLedger()).ok).toBe(true);
    await seed(2);
    expect(await seqs()).toEqual([8, 9, 10]); // no restart at genesis, ever
    expect((await verifyWithLedger()).ok).toBe(true);
  });

  it('concurrent appends between announce and finalize do not disturb the boundary', async () => {
    await seed(6);
    const before = await createdAtOfSeq(4);
    const b = await begin(before);
    await seed(3);
    await audit.purgeAuditLogEntries(TENANT, { before, confirm: true });
    await seed(2);
    expect(await finalize()).toEqual(
      expect.objectContaining({
        action: 'committed',
        boundary: { throughSeq: 3, prevHash: b!.boundary.prevHash },
      }),
    );
    expect((await verifyWithLedger()).ok).toBe(true);
    expect(await AuditLog.countDocuments({})).toBe(8);
  });
});

describe('crash recovery — the chain is the source of truth', () => {
  it('delete happened, commit never ran ⇒ finalize on the next pass commits it as recovered', async () => {
    await seed(6);
    const before = await createdAtOfSeq(4);
    await begin(before);
    await audit.purgeAuditLogEntries(TENANT, { before, confirm: true });
    const outcome = await finalize(2, { recovered: true }); // next holder, higher fence
    expect(outcome).toEqual({
      action: 'committed',
      boundary: expect.objectContaining({ throughSeq: 3 }),
      recovered: true,
    });
    const state = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect(state).toEqual(expect.objectContaining({ recoveredCommits: 1, lastFence: 2 }));
    expect((await verifyWithLedger()).ok).toBe(true);
  });

  it('delete never happened ⇒ the intent is dropped, nothing is legitimized', async () => {
    await seed(6);
    await begin(await createdAtOfSeq(4));
    expect(await finalize()).toEqual({ action: 'dropped', reason: 'nothing-deleted' });
    expect(await ledger.getAuditRetentionCheckpoint(SCOPE)).toEqual(
      expect.objectContaining({ throughSeq: 0, pending: null, purgedAt: undefined }),
    );
  });

  it('everything-old intent, crash before delete ⇒ dropped, all rows still there', async () => {
    await seed(3);
    await begin(FUTURE()); // through seq 2
    expect(await finalize(1, { recovered: true })).toEqual({
      action: 'dropped',
      reason: 'nothing-deleted',
    });
    expect(await seqs()).toEqual([1, 2, 3]);
  });

  it('PARTIAL delete (crash mid-deleteMany) ⇒ commits the boundary the chain actually has, inside the intent', async () => {
    await seed(6);
    await begin(await createdAtOfSeq(5)); // intent: through seq 4
    await AuditLog.collection.deleteMany({ seq: { $lte: 2 } });
    expect(await finalize()).toEqual(
      expect.objectContaining({
        action: 'committed',
        boundary: expect.objectContaining({ throughSeq: 2 }),
      }),
    );
    expect((await verifyWithLedger()).ok).toBe(true);
  });

  it('deletion BEYOND the intent is never legitimized', async () => {
    await seed(6);
    await begin(await createdAtOfSeq(3)); // through seq 2
    await AuditLog.collection.deleteMany({ seq: { $lte: 4 } });
    expect(await finalize()).toEqual({ action: 'dropped', reason: 'boundary-outside-intent' });
    expect((await audit.verifyAuditChain(TENANT)).ok).toBe(false);
  });

  it('an EMPTIED chain is never explained by any intent', async () => {
    await seed(3);
    await begin(FUTURE());
    await AuditLog.collection.deleteMany({});
    expect(await finalize()).toEqual({ action: 'dropped', reason: 'boundary-outside-intent' });
  });
});

describe('authenticated intent — not an HMAC oracle', () => {
  const forge = (pending: object) =>
    Checkpoint.updateOne(
      { scopeKey: SCOPE },
      {
        $set: { pending },
        $setOnInsert: {
          throughSeq: 0,
          prevHash: 'g',
          totalDeleted: 0,
          recoveredCommits: 0,
          lastFence: 0,
        },
      },
      { upsert: true },
    );

  it('a legitimate signed intent commits and the checkpoint is signed', async () => {
    await seed(6);
    const { outcome } = await purgeThrough(await createdAtOfSeq(4), KEY);
    expect(outcome!.action).toBe('committed');
    expect(
      verifyAuditCheckpointSignature((await ledger.getAuditRetentionCheckpoint(SCOPE))!, KEY),
    ).toBe('valid');
  });

  it('forged UNSIGNED pending + deleted prefix ⇒ untrusted-intent, nothing committed or signed', async () => {
    await seed(6);
    const before = await createdAtOfSeq(4);
    const b = await ledger.computeAuditRetentionBoundary(TENANT, before);
    await forge({
      throughSeq: b!.throughSeq,
      prevHash: b!.prevHash,
      startedAt: NOW(),
      cutoff: before,
      owner: 'evil',
      fence: 1,
    });
    await AuditLog.collection.deleteMany({ seq: { $lte: 3 } });
    expect(await finalize(2, { recovered: true, signingKeys: KEY })).toEqual({
      action: 'dropped',
      reason: 'untrusted-intent',
    });
    const state = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect(state).toEqual(expect.objectContaining({ throughSeq: 0, pending: null }));
    expect(state!.signature).toBeUndefined();
    expect((await audit.verifyAuditChain(TENANT)).ok).toBe(false);
  });

  it('wrong-key signature and an edited signed intent are refused', async () => {
    await seed(6);
    const before = await createdAtOfSeq(4);
    const b = await ledger.computeAuditRetentionBoundary(TENANT, before);
    const intent = {
      throughSeq: b!.throughSeq,
      prevHash: b!.prevHash,
      startedAt: NOW(),
      cutoff: before,
      owner: 'evil',
      fence: 1,
    };
    await forge({
      ...intent,
      signature: signAuditIntent({ scopeKey: SCOPE, ...intent }, 'not-the-key'),
    });
    await AuditLog.collection.deleteMany({ seq: { $lte: 3 } });
    expect(await finalize(2, { signingKeys: KEY })).toEqual({
      action: 'dropped',
      reason: 'untrusted-intent',
    });

    await AuditLog.collection.deleteMany({});
    await Checkpoint.deleteMany({});
    await seed(6);
    await begin(await createdAtOfSeq(3), 1, KEY); // signed, through seq 2
    await Checkpoint.updateOne({ scopeKey: SCOPE }, { $set: { 'pending.throughSeq': 4 } }); // widen it
    await AuditLog.collection.deleteMany({ seq: { $lte: 4 } });
    expect(await finalize(1, { signingKeys: KEY })).toEqual({
      action: 'dropped',
      reason: 'untrusted-intent',
    });
  });

  it('rotation: an intent signed with the previous key is still accepted; the commit is signed with the current one', async () => {
    await seed(6);
    const before = await createdAtOfSeq(4);
    await begin(before, 1, 'old');
    await audit.purgeAuditLogEntries(TENANT, { before, confirm: true });
    expect(await finalize(1, { signingKeys: { current: 'new', previous: 'old' } })).toEqual(
      expect.objectContaining({ action: 'committed' }),
    );
    const state = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect(verifyAuditCheckpointSignature(state!, { current: 'new' })).toBe('valid');
    expect(verifyAuditCheckpointSignature(state!, { current: 'old' })).toBe('invalid');
  });

  it('signature helpers: valid / invalid / missing / unsigned', () => {
    const i = {
      scopeKey: SCOPE,
      throughSeq: 3,
      prevHash: 'h',
      cutoff: NOW(),
      startedAt: NOW(),
      owner: OWNER,
      fence: 1,
    };
    const signature = signAuditIntent(i, KEY);
    expect(verifyAuditIntentSignature({ ...i, signature }, KEY)).toBe('valid');
    expect(verifyAuditIntentSignature({ ...i, signature, fence: 2 }, KEY)).toBe('invalid');
    expect(verifyAuditIntentSignature({ ...i }, KEY)).toBe('missing');
    expect(verifyAuditIntentSignature({ ...i }, undefined)).toBe('unsigned');
    expect(verifyAuditIntentSignature({ ...i, signature }, { current: 'x', previous: KEY })).toBe(
      'valid',
    );
  });
});

describe('fencing — a lapsed holder cannot write', () => {
  it('lease grants a monotonically increasing fence; renew and release are fence-scoped; release stamps completion', async () => {
    const t0 = new Date();
    expect(await ledger.acquireAuditRetentionLease({ owner: 'a', ttlMs: 60_000, now: t0 })).toEqual(
      { ok: true, fence: 1 },
    );
    expect(await ledger.acquireAuditRetentionLease({ owner: 'b', ttlMs: 60_000, now: t0 })).toEqual(
      { ok: false, reason: 'held' },
    );
    expect(
      await ledger.renewAuditRetentionLease({ owner: 'a', fence: 1, ttlMs: 60_000, now: t0 }),
    ).toBe(true);
    expect(
      await ledger.renewAuditRetentionLease({ owner: 'a', fence: 0, ttlMs: 60_000, now: t0 }),
    ).toBe(false);
    const later = new Date(t0.getTime() + 61_000);
    expect(
      await ledger.renewAuditRetentionLease({ owner: 'a', fence: 1, ttlMs: 60_000, now: later }),
    ).toBe(false); // expired
    expect(
      await ledger.acquireAuditRetentionLease({ owner: 'b', ttlMs: 60_000, now: later }),
    ).toEqual({ ok: true, fence: 2 });
    expect(
      await ledger.renewAuditRetentionLease({ owner: 'a', fence: 1, ttlMs: 60_000, now: later }),
    ).toBe(false);
    await ledger.releaseAuditRetentionLease({ owner: 'b', fence: 2, now: later });
    const row = (await Lease.findOne({ name: AUDIT_RETENTION_SWEEP_LEASE }).lean())!;
    expect(row.fence).toBe(2);
    expect(row.lastCompletedAt?.getTime()).toBe(later.getTime());
    expect(
      await ledger.acquireAuditRetentionLease({ owner: 'c', ttlMs: 60_000, now: later }),
    ).toEqual({ ok: true, fence: 3 });
  });

  it('boot-storm guard: a pass that completed within minGapMs is refused; a one-shot (minGap 0) is not', async () => {
    const t0 = new Date();
    const g = await ledger.acquireAuditRetentionLease({ owner: 'a', ttlMs: 60_000, now: t0 });
    await ledger.releaseAuditRetentionLease({
      owner: 'a',
      fence: (g as { fence: number }).fence,
      now: t0,
    });
    const soon = new Date(t0.getTime() + 1000);
    expect(
      await ledger.acquireAuditRetentionLease({
        owner: 'b',
        ttlMs: 60_000,
        now: soon,
        minGapMs: 60_000,
      }),
    ).toEqual({ ok: false, reason: 'recently-completed' });
    expect(
      await ledger.acquireAuditRetentionLease({
        owner: 'b',
        ttlMs: 60_000,
        now: soon,
        minGapMs: 0,
      }),
    ).toEqual({ ok: true, fence: 2 });
  });

  it('lease: a burst of contenders yields exactly one holder', async () => {
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        ledger.acquireAuditRetentionLease({ owner: `w${i}`, ttlMs: 60_000, now }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('competing writers with DIFFERENT boundaries: higher fence wins; stale fence cannot begin, finalize or drop', async () => {
    await seed(8);
    expect((await begin(await createdAtOfSeq(3), 1))!.ok).toBe(true); // fence 1: through 2
    expect((await begin(await createdAtOfSeq(6), 2))!.ok).toBe(true); // fence 2: through 5
    expect((await Checkpoint.findOne({ scopeKey: SCOPE }).lean())!.pending!.throughSeq).toBe(5);
    expect((await begin(await createdAtOfSeq(3), 1))!.ok).toBe(false); // stale
    await audit.purgeAuditLogEntries(TENANT, { before: await createdAtOfSeq(6), confirm: true });
    expect(await finalize(1)).toEqual({ action: 'dropped', reason: 'stale-fence' });
    expect((await Checkpoint.findOne({ scopeKey: SCOPE }).lean())!.pending!.throughSeq).toBe(5); // untouched
    expect(await finalize(2, { deletedCount: 5 })).toEqual(
      expect.objectContaining({
        action: 'committed',
        boundary: expect.objectContaining({ throughSeq: 5 }),
      }),
    );
    expect((await ledger.getAuditRetentionCheckpoint(SCOPE))!.lastFence).toBe(2);
    expect((await verifyWithLedger()).ok).toBe(true);
  });

  it("FIRST document race: a stale holder cannot overwrite a fresher holder's first intent", async () => {
    await seed(8);
    expect((await begin(await createdAtOfSeq(6), 2))!.ok).toBe(true); // fresh writer creates the document
    expect((await begin(await createdAtOfSeq(3), 1))!.ok).toBe(false); // stale writer arrives late
    expect((await Checkpoint.findOne({ scopeKey: SCOPE }).lean())!.pending!.throughSeq).toBe(5);
  });

  it('12 concurrent begin+finalize: exactly one document, one commit, no lost update', async () => {
    await seed(6);
    const before = await createdAtOfSeq(4);
    const oks = await Promise.all(Array.from({ length: 12 }, () => begin(before, 1)));
    expect(oks.every((o) => o!.ok)).toBe(true);
    expect(await Checkpoint.countDocuments({ scopeKey: SCOPE })).toBe(1);
    await audit.purgeAuditLogEntries(TENANT, { before, confirm: true });
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => finalize(1, { deletedCount: 3 })),
    );
    expect(outcomes.filter((o) => o.action === 'committed')).toHaveLength(1);
    expect(await ledger.getAuditRetentionCheckpoint(SCOPE)).toEqual(
      expect.objectContaining({ throughSeq: 3, totalDeleted: 3 }),
    );
  });
});

describe('checkpoint signature', () => {
  it('commit signs when a key is given; a tampered boundary is invalid; activation shows missing', async () => {
    await seed(6);
    await purgeThrough(await createdAtOfSeq(4), KEY);
    const state = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect(verifyAuditCheckpointSignature(state!, KEY)).toBe('valid');
    expect(verifyAuditCheckpointSignature(state!, 'other')).toBe('invalid');
    expect(verifyAuditCheckpointSignature(state!, undefined)).toBe('unsigned');
    expect(signAuditCheckpoint(state!, KEY)).toBe(state!.signature);
    await Checkpoint.updateOne({ scopeKey: SCOPE }, { $set: { throughSeq: 5 } });
    expect(
      verifyAuditCheckpointSignature((await ledger.getAuditRetentionCheckpoint(SCOPE))!, KEY),
    ).toBe('invalid');
    await Checkpoint.updateOne({ scopeKey: SCOPE }, { $unset: { signature: '' } });
    expect(
      verifyAuditCheckpointSignature((await ledger.getAuditRetentionCheckpoint(SCOPE))!, KEY),
    ).toBe('missing');
  });

  it('unsigned commits report unsigned without a key and missing with one', async () => {
    await seed(4);
    await purgeThrough(await createdAtOfSeq(3));
    const state = await ledger.getAuditRetentionCheckpoint(SCOPE);
    expect(state!.signature).toBeUndefined();
    expect(verifyAuditCheckpointSignature(state!, undefined)).toBe('unsigned');
    expect(verifyAuditCheckpointSignature(state!, KEY)).toBe('missing');
  });
});
// End [knauf]
