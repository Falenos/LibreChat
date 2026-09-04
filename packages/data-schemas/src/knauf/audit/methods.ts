// [knauf] KK20-328 — the audit-retention ledger: signed write-ahead purge intent,
// fenced compare-and-set commit, crash recovery from the chain itself, and a fenced
// single-document lease for the sweep.
//
// Why a write-ahead intent instead of a transaction: the delete lives in upstream's
// `purgeAuditLogEntries` (raw `deleteMany`, no session parameter), the platform is
// Cosmos DB for MongoDB where cross-collection transactions are not a given, and a
// transaction would not survive a process kill between the delete and the commit
// anyway. Announcing the boundary BEFORE deleting means the surviving chain is always
// enough to finish the job: after any crash — even one mid-`deleteMany` — `finalize`
// reads the first surviving entry and commits the boundary the chain actually has, as
// long as it lies within what was announced. Nothing outside the announced intent is
// ever legitimized.
//
// Properties the reviews demanded, and where each lives:
//   - NEVER EMPTY A CHAIN: `computeAuditRetentionBoundary` always retains the newest
//     row, so upstream's delete is always bounded by a retained `seq`, recovery never
//     has to guess whether a chain restarted, and an empty chain is unexplained by
//     construction (types.ts DESIGN RULE).
//   - AUTHENTICATED INTENT: `begin` signs the intent with the external key; `finalize`
//     refuses (`untrusted-intent`) to commit or sign anything whose intent signature
//     does not verify. A forged `pending` written with the Mongo credential is inert.
//   - FENCING: every ledger write carries the holder's lease fence and is a no-op if
//     the document has already been written by a higher fence (`stale-fence`) —
//     including the very first document for a scope.
//   - INDEXES: the fenced lease and the CAS lean on the unique indexes turning a
//     concurrent insert into a duplicate-key error; they are created before the first
//     write because `MONGO_AUTO_INDEX=false` is a supported setting.
import type { Model } from 'mongoose';
import type {
  AuditRetentionBoundary,
  AuditRetentionCheckpointState,
  AuditRetentionDropReason,
  AuditRetentionFinalizeOutcome,
  AuditRetentionLeaseGrant,
  AuditRetentionPendingPurge,
  IKnaufAuditRetentionCheckpoint,
  IKnaufAuditRetentionLease,
} from './types';
import type { AuditSigningKeys } from './signature';
import type { IAuditLog } from '~/types';
import { signAuditCheckpoint, signAuditIntent, verifyAuditIntentSignature } from './signature';
import { auditChainKey } from '~/methods/auditLog';
import { GENESIS_HASH } from '~/schema/auditLog';

/**
 * Scope key for a tenant, or the platform sentinel. It IS upstream's `chainKey`
 * (`auditChainKey`, an exported helper — `tenant:<id>` or `__platform__`), so the
 * checkpoint ledger and the chain it describes share one partition key and can never
 * disagree on it. Both the sweep (writing) and chain verification (reading) go through
 * this alias so the intent is visible at the call sites.
 */
export function auditRetentionScopeKey(tenantId?: string): string {
  return auditChainKey(tenantId);
}

export const AUDIT_RETENTION_SWEEP_LEASE: string = 'knauf-audit-retention-sweep';

const CAS_ATTEMPTS = 3;

function currentKey(keys: string | AuditSigningKeys | undefined): string | undefined {
  if (typeof keys === 'string') {
    return keys.length > 0 ? keys : undefined;
  }
  return keys?.current && keys.current.length > 0 ? keys.current : undefined;
}

/** Explicit return type: `--isolatedDeclarations` rejects the inferred factory shape. */
export interface AuditRetentionCheckpointMethods {
  getAuditRetentionCheckpoint(scopeKey: string): Promise<AuditRetentionCheckpointState | undefined>;
  /** What the purge should delete through, always retaining the newest row. `null`
   *  when there is nothing to purge. */
  computeAuditRetentionBoundary(
    tenantId: string | undefined,
    before: Date,
  ): Promise<AuditRetentionBoundary | null>;
  /** Rows strictly older than `before` in a scope — the dry-run estimate. */
  countAuditEntriesBefore(tenantId: string | undefined, before: Date): Promise<number>;
  /** Write-ahead: record (and sign) the intended boundary BEFORE deleting. Returns
   *  false when the caller's fence is stale — the caller must not delete. */
  beginAuditRetentionPurge(params: {
    scopeKey: string;
    boundary: AuditRetentionBoundary;
    cutoff: Date;
    now: Date;
    owner: string;
    fence: number;
    signingKeys?: string | AuditSigningKeys;
  }): Promise<boolean>;
  /** After the delete (or after a crash): verify the intent, read the chain, commit
   *  the boundary it actually has if it lies within the intent, else drop the intent. */
  finalizeAuditRetentionPurge(params: {
    scopeKey: string;
    tenantId: string | undefined;
    fence: number;
    deletedCount?: number;
    now: Date;
    signingKeys?: string | AuditSigningKeys;
    recovered?: boolean;
  }): Promise<AuditRetentionFinalizeOutcome>;
  acquireAuditRetentionLease(params: {
    name?: string;
    owner: string;
    ttlMs: number;
    now: Date;
    /** Refuse (`recently-completed`) if a pass finished less than this long ago. */
    minGapMs?: number;
  }): Promise<AuditRetentionLeaseGrant>;
  renewAuditRetentionLease(params: {
    name?: string;
    owner: string;
    fence: number;
    ttlMs: number;
    now: Date;
  }): Promise<boolean>;
  releaseAuditRetentionLease(params: {
    name?: string;
    owner: string;
    fence: number;
    now: Date;
  }): Promise<void>;
}

export function createAuditRetentionCheckpointMethods(
  mongoose: typeof import('mongoose'),
): AuditRetentionCheckpointMethods {
  function checkpoints(): Model<IKnaufAuditRetentionCheckpoint> {
    return mongoose.models.KnaufAuditRetentionCheckpoint as Model<IKnaufAuditRetentionCheckpoint>;
  }
  function leases(): Model<IKnaufAuditRetentionLease> {
    return mongoose.models.KnaufAuditRetentionLease as Model<IKnaufAuditRetentionLease>;
  }
  function auditLog(): Model<IAuditLog> {
    return mongoose.models.AuditLog as Model<IAuditLog>;
  }

  /* `createIndexes()` (not `init()`, which honours autoIndex=false) — once per process,
   * before the first write. Same guard upstream `recordAuditEntry` uses for its unique
   * `{chainKey, seq}` index. */
  let indexesReady: Promise<void> | null = null;
  function ensureIndexes(): Promise<void> {
    indexesReady ??= Promise.all([checkpoints().createIndexes(), leases().createIndexes()]).then(
      () => undefined,
    );
    return indexesReady;
  }

  function toState(doc: IKnaufAuditRetentionCheckpoint): AuditRetentionCheckpointState {
    return {
      scopeKey: doc.scopeKey,
      throughSeq: doc.throughSeq,
      prevHash: doc.prevHash,
      purgedAt: doc.purgedAt ?? undefined,
      totalDeleted: doc.totalDeleted,
      recoveredCommits: doc.recoveredCommits ?? 0,
      lastFence: doc.lastFence ?? 0,
      signature: doc.signature ?? undefined,
      pending: doc.pending ?? null,
    };
  }

  async function getAuditRetentionCheckpoint(
    scopeKey: string,
  ): Promise<AuditRetentionCheckpointState | undefined> {
    const doc = await checkpoints().findOne({ scopeKey }).lean<IKnaufAuditRetentionCheckpoint>();
    return doc ? toState(doc) : undefined;
  }

  async function computeAuditRetentionBoundary(
    tenantId: string | undefined,
    before: Date,
  ): Promise<AuditRetentionBoundary | null> {
    const chainKey = auditChainKey(tenantId);
    /* Cheap steady-state exit, served by the {chainKey, createdAt} index prefix: no row
     * older than the cutoff ⇒ nothing to purge. Under clock skew this is only
     * conservative (a skewed old row still triggers the full computation below). */
    if (!(await auditLog().exists({ chainKey, createdAt: { $lt: before } }))) {
      return null;
    }
    /* Same query upstream's purge runs: the earliest entry (by seq) that must be
     * retained. Everything with a lower seq is the prefix. New entries only ever
     * append with higher seq, so this boundary cannot move between here and the
     * delete. */
    let retained = await auditLog()
      .findOne({ chainKey, createdAt: { $gte: before } })
      .sort({ seq: 1 })
      .select('seq prevHash createdAt')
      .lean<{ seq: number; prevHash: string; createdAt: Date }>();
    let purgeBefore = before;
    if (!retained) {
      /* Everything is older than the cutoff. NEVER empty the chain: retain the newest
       * row as the anchor and purge through the one before it. Handing upstream that
       * row's own `createdAt` makes it the first retained entry, so the delete stays
       * bounded (`seq < newest.seq`) instead of degrading to `{ chainKey }`. */
      retained = await auditLog()
        .findOne({ chainKey })
        .sort({ seq: -1 })
        .select('seq prevHash createdAt')
        .lean<{ seq: number; prevHash: string; createdAt: Date }>();
      if (!retained) {
        return null;
      }
      purgeBefore = retained.createdAt;
    }
    /* Nothing below the retained entry ⇒ nothing to purge. This is the normal state
     * right after a purge (the chain now STARTS at the retained entry) and must not be
     * mistaken for the already-deleted prefix. */
    const hasPrefix = await auditLog().exists({ chainKey, seq: { $lt: retained.seq } });
    if (!hasPrefix) {
      return null;
    }
    return { throughSeq: retained.seq - 1, prevHash: retained.prevHash, purgeBefore };
  }

  async function countAuditEntriesBefore(
    tenantId: string | undefined,
    before: Date,
  ): Promise<number> {
    return auditLog().countDocuments({
      chainKey: auditChainKey(tenantId),
      createdAt: { $lt: before },
    });
  }

  async function beginAuditRetentionPurge(params: {
    scopeKey: string;
    boundary: AuditRetentionBoundary;
    cutoff: Date;
    now: Date;
    owner: string;
    fence: number;
    signingKeys?: string | AuditSigningKeys;
  }): Promise<boolean> {
    const { scopeKey, boundary, cutoff, now, owner, fence } = params;
    const signingKey = currentKey(params.signingKeys);
    await ensureIndexes();
    const pending: AuditRetentionPendingPurge = {
      throughSeq: boundary.throughSeq,
      prevHash: boundary.prevHash,
      startedAt: now,
      cutoff,
      owner,
      fence,
    };
    if (signingKey) {
      pending.signature = signAuditIntent({ scopeKey, ...pending }, signingKey);
    }
    for (let attempt = 1; attempt <= CAS_ATTEMPTS; attempt++) {
      try {
        /* One fenced upsert covers both "first document" and "existing document": a
         * document written by a higher fence matches nothing, and the resulting insert
         * attempt collides with the unique index — that duplicate key IS "stale". */
        const res = await checkpoints().updateOne(
          { scopeKey, lastFence: { $lte: fence } },
          {
            $set: { pending },
            $max: { lastFence: fence },
            $setOnInsert: {
              throughSeq: 0,
              prevHash: GENESIS_HASH,
              totalDeleted: 0,
              recoveredCommits: 0,
            },
          },
          { upsert: true },
        );
        return res.matchedCount === 1 || res.upsertedCount === 1;
      } catch (err) {
        if ((err as { code?: number })?.code !== 11000) {
          throw err;
        }
        /* Someone inserted first. If their fence is higher we are stale; if it is ours
         * or lower (a simultaneous first-write race), retry as a plain fenced update. */
        const doc = await checkpoints()
          .findOne({ scopeKey })
          .select('lastFence')
          .lean<{ lastFence?: number }>();
        if (doc && (doc.lastFence ?? 0) > fence) {
          return false;
        }
        if (attempt === CAS_ATTEMPTS) {
          return false;
        }
      }
    }
    return false;
  }

  async function finalizeAuditRetentionPurge(params: {
    scopeKey: string;
    tenantId: string | undefined;
    fence: number;
    deletedCount?: number;
    now: Date;
    signingKeys?: string | AuditSigningKeys;
    recovered?: boolean;
  }): Promise<AuditRetentionFinalizeOutcome> {
    const { scopeKey, tenantId, fence, now } = params;
    const signingKey = currentKey(params.signingKeys);
    const chainKey = auditChainKey(tenantId);

    for (let attempt = 1; attempt <= CAS_ATTEMPTS; attempt++) {
      const doc = await checkpoints().findOne({ scopeKey }).lean<IKnaufAuditRetentionCheckpoint>();
      if (!doc?.pending) {
        return { action: 'none', reason: 'no-pending' };
      }
      if ((doc.lastFence ?? 0) > fence) {
        /* Our lease lapsed and a later holder has written. Touch nothing. */
        return { action: 'dropped', reason: 'stale-fence' };
      }
      const intent = doc.pending;

      /* AUTHENTICATED INTENT. Under a configured key, an intent that does not carry a
       * valid signature (current or previous key) was not written by a legitimate
       * `begin` — refuse to certify, and thereby sign, whatever deletion followed it. */
      if (signingKey) {
        const status = verifyAuditIntentSignature({ scopeKey, ...intent }, params.signingKeys);
        if (status !== 'valid') {
          return await dropPending(doc, 'untrusted-intent');
        }
      }

      /* The chain is the source of truth for what actually happened. Because retention
       * never empties a chain, an empty chain here is always outside any intent. */
      const first = await auditLog()
        .findOne({ chainKey })
        .sort({ seq: 1 })
        .select('seq prevHash')
        .lean<{ seq: number; prevHash: string }>();
      if (!first) {
        return await dropPending(doc, 'boundary-outside-intent');
      }
      const actual = { throughSeq: first.seq - 1, prevHash: first.prevHash };

      /* Never legitimize past the announced intent, and never move backwards. */
      if (actual.throughSeq > intent.throughSeq) {
        return await dropPending(doc, 'boundary-outside-intent');
      }
      if (actual.throughSeq <= doc.throughSeq) {
        return await dropPending(doc, 'nothing-deleted');
      }

      const committed = { scopeKey, throughSeq: actual.throughSeq, prevHash: actual.prevHash };
      const res = await checkpoints().updateOne(
        /* CAS on the exact state read, fenced. A concurrent finalizer or a later
         * lease holder changes one of these and this matches nothing. */
        {
          scopeKey,
          throughSeq: doc.throughSeq,
          lastFence: doc.lastFence ?? 0,
          'pending.throughSeq': intent.throughSeq,
          'pending.startedAt': intent.startedAt,
          'pending.fence': intent.fence,
        },
        {
          $set: {
            ...committed,
            purgedAt: now,
            pending: null,
            ...(signingKey ? { signature: signAuditCheckpoint(committed, signingKey) } : {}),
          },
          ...(signingKey ? {} : { $unset: { signature: '' } }),
          $max: { lastFence: fence },
          $inc: {
            totalDeleted: params.deletedCount ?? 0,
            recoveredCommits: params.recovered ? 1 : 0,
          },
        },
      );
      if (res.matchedCount === 1) {
        return { action: 'committed', boundary: actual, recovered: params.recovered === true };
      }
      /* Lost the race — re-read and re-evaluate against the winner's state. */
    }
    return { action: 'dropped', reason: 'lost-race' };

    async function dropPending(
      doc: IKnaufAuditRetentionCheckpoint,
      reason: AuditRetentionDropReason,
    ): Promise<AuditRetentionFinalizeOutcome> {
      await checkpoints().updateOne(
        {
          scopeKey,
          lastFence: { $lte: fence },
          'pending.startedAt': doc.pending?.startedAt,
          'pending.fence': doc.pending?.fence,
        },
        { $set: { pending: null }, $max: { lastFence: fence } },
      );
      return { action: 'dropped', reason };
    }
  }

  /* ------------------------------------------------------------------ lease */

  async function acquireAuditRetentionLease(params: {
    name?: string;
    owner: string;
    ttlMs: number;
    now: Date;
    minGapMs?: number;
  }): Promise<AuditRetentionLeaseGrant> {
    const name = params.name ?? AUDIT_RETENTION_SWEEP_LEASE;
    const expiresAt = new Date(params.now.getTime() + params.ttlMs);
    await ensureIndexes();
    /* Boot-storm guard: ten replicas starting together must not run ten passes. */
    if (params.minGapMs && params.minGapMs > 0) {
      const recent = await leases()
        .findOne({
          name,
          lastCompletedAt: { $gt: new Date(params.now.getTime() - params.minGapMs) },
        })
        .select('_id')
        .lean();
      if (recent) {
        return { ok: false, reason: 'recently-completed' };
      }
    }
    try {
      /* Take the row if it is ours, expired, or absent (upsert). A live row held by
       * someone else matches nothing, so the upsert path collides with the unique
       * index — that duplicate-key error IS "someone else holds it". Every grant
       * bumps the fence, so a holder that lapsed and re-acquires gets a NEW token
       * and its old writes are recognizably stale. */
      const doc = await leases()
        .findOneAndUpdate(
          { name, $or: [{ owner: params.owner }, { expiresAt: { $lte: params.now } }] },
          {
            $set: { owner: params.owner, expiresAt, acquiredAt: params.now },
            $inc: { fence: 1 },
          },
          { upsert: true, returnDocument: 'after' },
        )
        .lean<{ fence: number }>();
      return doc ? { ok: true, fence: doc.fence } : { ok: false, reason: 'held' };
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) {
        return { ok: false, reason: 'held' };
      }
      throw err;
    }
  }

  async function renewAuditRetentionLease(params: {
    name?: string;
    owner: string;
    fence: number;
    ttlMs: number;
    now: Date;
  }): Promise<boolean> {
    const name = params.name ?? AUDIT_RETENTION_SWEEP_LEASE;
    /* Owner AND fence AND not yet expired: a holder that lapsed and was re-granted a new
     * fence must not extend the old one, and an expired-but-not-taken-over lease may
     * not be renewed either — expiry is the contract. */
    const res = await leases().updateOne(
      { name, owner: params.owner, fence: params.fence, expiresAt: { $gt: params.now } },
      { $set: { expiresAt: new Date(params.now.getTime() + params.ttlMs) } },
    );
    return res.matchedCount === 1;
  }

  async function releaseAuditRetentionLease(params: {
    name?: string;
    owner: string;
    fence: number;
    now: Date;
  }): Promise<void> {
    /* Releasing does not delete the row — the fence must keep counting up. Expire it
     * and stamp the completion so the boot-storm guard has something to look at. */
    await leases().updateOne(
      {
        name: params.name ?? AUDIT_RETENTION_SWEEP_LEASE,
        owner: params.owner,
        fence: params.fence,
      },
      { $set: { expiresAt: new Date(0), lastCompletedAt: params.now } },
    );
  }

  return {
    getAuditRetentionCheckpoint,
    computeAuditRetentionBoundary,
    countAuditEntriesBefore,
    beginAuditRetentionPurge,
    finalizeAuditRetentionPurge,
    acquireAuditRetentionLease,
    renewAuditRetentionLease,
    releaseAuditRetentionLease,
  };
}
// End [knauf]
