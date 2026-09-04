// [knauf] KK20-328 — the audit-retention ledger: write-ahead purge intent, CAS commit,
// terminal checkpoints with generations, crash recovery from the chain itself, and a
// renewable single-document lease for the sweep.
//
// Why a write-ahead intent instead of a transaction: the delete lives in upstream's
// `purgeAuditLogEntries` (raw `deleteMany`, no session parameter), the platform is
// Cosmos DB for MongoDB where cross-collection transactions are not a given, and a
// transaction would not survive a process kill between the delete and the commit
// anyway unless both were inside it. Announcing the boundary BEFORE deleting means
// the surviving chain is always enough to finish the job: after any crash — even one
// mid-`deleteMany` that removed part of the prefix — `finalize` reads the first
// surviving entry and commits the boundary the chain actually has, as long as it lies
// within what was announced. Nothing outside the announced intent is ever legitimized.
import type { Model } from 'mongoose';
import type {
  AuditRetentionBoundary,
  AuditRetentionCheckpointState,
  AuditRetentionFinalizeOutcome,
  IKnaufAuditRetentionCheckpoint,
  IKnaufAuditRetentionLease,
} from './types';
import type { IAuditLog } from '~/types';
import { GENESIS_HASH, PLATFORM_CHAIN_KEY } from '~/schema/auditLog';
import { auditChainKey } from '~/methods/auditLog';
import { signAuditCheckpoint } from './signature';

/**
 * Scope key for a tenant, or the platform sentinel. Both the sweep (writing) and
 * chain verification (reading) go through this so the two can never disagree.
 * Namespaced so a tenant literally named `__platform__` cannot share the platform
 * scope's document. Private key space — never compared against upstream's `chainKey`.
 */
const SCOPE_TENANT_PREFIX = 'scope:tenant:';

export function auditRetentionScopeKey(tenantId?: string): string {
  return typeof tenantId === 'string' && tenantId.trim().length > 0
    ? `${SCOPE_TENANT_PREFIX}${tenantId}`
    : PLATFORM_CHAIN_KEY;
}

export const AUDIT_RETENTION_SWEEP_LEASE: string = 'knauf-audit-retention-sweep';

const CAS_ATTEMPTS = 3;

/** Explicit return type: `--isolatedDeclarations` rejects the inferred factory shape. */
export interface AuditRetentionCheckpointMethods {
  getAuditRetentionCheckpoint(scopeKey: string): Promise<AuditRetentionCheckpointState | undefined>;
  /** Read-only mirror of upstream's purge boundary: what `purgeAuditLogEntries(before)`
   *  WOULD delete through. `null` when there is nothing to purge. */
  computeAuditRetentionBoundary(
    tenantId: string | undefined,
    before: Date,
  ): Promise<AuditRetentionBoundary | null>;
  /** Rows strictly older than `before` in a scope — the dry-run estimate. */
  countAuditEntriesBefore(tenantId: string | undefined, before: Date): Promise<number>;
  /** Write-ahead: record the intended boundary BEFORE deleting. Idempotent. */
  beginAuditRetentionPurge(params: {
    scopeKey: string;
    boundary: AuditRetentionBoundary;
    cutoff: Date;
    now: Date;
  }): Promise<void>;
  /** After the delete (or after a crash): read the chain, commit the boundary it
   *  actually has if it lies within the announced intent, else drop the intent. */
  finalizeAuditRetentionPurge(params: {
    scopeKey: string;
    tenantId: string | undefined;
    deletedCount?: number;
    now: Date;
    signingKey?: string;
    recovered?: boolean;
  }): Promise<AuditRetentionFinalizeOutcome>;
  acquireAuditRetentionLease(params: {
    name?: string;
    owner: string;
    ttlMs: number;
    now: Date;
  }): Promise<boolean>;
  renewAuditRetentionLease(params: {
    name?: string;
    owner: string;
    ttlMs: number;
    now: Date;
  }): Promise<boolean>;
  releaseAuditRetentionLease(params: { name?: string; owner: string }): Promise<void>;
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

  function toState(doc: IKnaufAuditRetentionCheckpoint): AuditRetentionCheckpointState {
    return {
      scopeKey: doc.scopeKey,
      generation: doc.generation,
      throughSeq: doc.throughSeq,
      prevHash: doc.prevHash,
      terminal: doc.terminal,
      purgedAt: doc.purgedAt ?? undefined,
      totalDeleted: doc.totalDeleted,
      recoveredCommits: doc.recoveredCommits ?? 0,
      signature: doc.signature ?? undefined,
      pending: doc.pending ?? null,
    };
  }

  async function getAuditRetentionCheckpoint(
    scopeKey: string,
  ): Promise<AuditRetentionCheckpointState | undefined> {
    const doc = await checkpoints().findOne({ scopeKey }).lean<IKnaufAuditRetentionCheckpoint>();
    /* A document that only ever carried an intent (begin without a commit, e.g.
     * a purge that turned out to delete nothing) is not a checkpoint yet. */
    if (!doc || (doc.throughSeq === 0 && !doc.purgedAt)) {
      return doc ? { ...toState(doc) } : undefined;
    }
    return toState(doc);
  }

  async function computeAuditRetentionBoundary(
    tenantId: string | undefined,
    before: Date,
  ): Promise<AuditRetentionBoundary | null> {
    const chainKey = auditChainKey(tenantId);
    /* Same query upstream's purge runs: the earliest entry (by seq) that must be
     * retained. Everything with a lower seq is the prefix. New entries only ever
     * append with higher seq, so this boundary cannot move between here and the
     * delete. */
    const firstRetained = await auditLog()
      .findOne({ chainKey, createdAt: { $gte: before } })
      .sort({ seq: 1 })
      .select('seq prevHash')
      .lean<{ seq: number; prevHash: string }>();
    if (firstRetained) {
      /* Nothing below the first retained entry ⇒ nothing to purge. This is the
       * normal state right after a purge (the chain now STARTS at the retained
       * entry) and must not be mistaken for the already-deleted prefix. */
      const hasPrefix = await auditLog().exists({ chainKey, seq: { $lt: firstRetained.seq } });
      if (!hasPrefix) {
        return null;
      }
      return {
        throughSeq: firstRetained.seq - 1,
        prevHash: firstRetained.prevHash,
        terminal: false,
      };
    }
    const last = await auditLog()
      .findOne({ chainKey })
      .sort({ seq: -1 })
      .select('seq hash')
      .lean<{ seq: number; hash: string }>();
    if (!last) {
      return null;
    }
    return { throughSeq: last.seq, prevHash: last.hash, terminal: true };
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
  }): Promise<void> {
    const { scopeKey, boundary, cutoff, now } = params;
    const pending = { ...boundary, startedAt: now, cutoff };
    for (let attempt = 1; attempt <= CAS_ATTEMPTS; attempt++) {
      try {
        await checkpoints().updateOne(
          { scopeKey },
          {
            $set: { pending },
            $setOnInsert: {
              generation: 1,
              throughSeq: 0,
              prevHash: GENESIS_HASH,
              terminal: false,
              totalDeleted: 0,
              recoveredCommits: 0,
            },
          },
          { upsert: true },
        );
        return;
      } catch (err) {
        /* Two writers upserting the first document for a scope at once: the unique
         * index rejects the loser; retry as a plain update against the winner. */
        if ((err as { code?: number })?.code !== 11000 || attempt === CAS_ATTEMPTS) {
          throw err;
        }
      }
    }
  }

  async function finalizeAuditRetentionPurge(params: {
    scopeKey: string;
    tenantId: string | undefined;
    deletedCount?: number;
    now: Date;
    signingKey?: string;
    recovered?: boolean;
  }): Promise<AuditRetentionFinalizeOutcome> {
    const { scopeKey, tenantId, now, signingKey } = params;
    const chainKey = auditChainKey(tenantId);

    for (let attempt = 1; attempt <= CAS_ATTEMPTS; attempt++) {
      const doc = await checkpoints().findOne({ scopeKey }).lean<IKnaufAuditRetentionCheckpoint>();
      if (!doc?.pending) {
        return { action: 'none', reason: 'no-pending' };
      }
      const intent = doc.pending;

      /* The chain is the source of truth for what actually happened. */
      const first = await auditLog()
        .findOne({ chainKey })
        .sort({ seq: 1 })
        .select('seq prevHash')
        .lean<{ seq: number; prevHash: string }>();

      let actual: AuditRetentionBoundary;
      if (!first) {
        /* Chain empty: the purge ran to the end. Only legitimate if the intent
         * covered the whole chain — otherwise more is missing than we announced. */
        if (!intent.terminal) {
          return await dropPending(doc, 'boundary-outside-intent');
        }
        actual = { throughSeq: intent.throughSeq, prevHash: intent.prevHash, terminal: true };
      } else if (first.seq === 1) {
        if (intent.terminal && doc.terminal === false && doc.throughSeq < intent.throughSeq) {
          /* Terminal purge happened and the chain has ALREADY restarted at genesis
           * before we got here (a crash, then new entries). The intent carried the
           * old generation's final hash; commit it as terminal. */
          actual = { throughSeq: intent.throughSeq, prevHash: intent.prevHash, terminal: true };
        } else {
          return await dropPending(doc, 'nothing-deleted');
        }
      } else {
        actual = { throughSeq: first.seq - 1, prevHash: first.prevHash, terminal: false };
      }

      /* Never legitimize past the announced intent, and never move backwards
       * within a generation. A previous TERMINAL checkpoint means the chain
       * restarted at seq 1, so a lower throughSeq is expected — that opens the next
       * generation instead. */
      const opensGeneration = doc.terminal === true;
      if (actual.throughSeq > intent.throughSeq) {
        return await dropPending(doc, 'boundary-outside-intent');
      }
      if (!opensGeneration && actual.throughSeq <= doc.throughSeq) {
        return await dropPending(doc, 'nothing-deleted');
      }

      const generation = opensGeneration ? doc.generation + 1 : doc.generation;
      const committed = {
        scopeKey,
        generation,
        throughSeq: actual.throughSeq,
        prevHash: actual.prevHash,
        terminal: actual.terminal,
      };
      const res = await checkpoints().updateOne(
        /* CAS: only the exact state we read. A concurrent finalizer that got there
         * first changes generation/throughSeq/pending and this matches nothing. */
        {
          scopeKey,
          generation: doc.generation,
          throughSeq: doc.throughSeq,
          'pending.throughSeq': intent.throughSeq,
          'pending.startedAt': intent.startedAt,
        },
        {
          $set: {
            ...committed,
            purgedAt: now,
            pending: null,
            ...(signingKey ? { signature: signAuditCheckpoint(committed, signingKey) } : {}),
          },
          ...(signingKey ? {} : { $unset: { signature: '' } }),
          $inc: {
            totalDeleted: params.deletedCount ?? 0,
            recoveredCommits: params.recovered ? 1 : 0,
          },
        },
      );
      if (res.matchedCount === 1) {
        return {
          action: 'committed',
          boundary: actual,
          generation,
          recovered: params.recovered === true,
        };
      }
      /* Lost the race — re-read and re-evaluate against the winner's state. */
    }
    return { action: 'dropped', reason: 'lost-race' };

    async function dropPending(
      doc: IKnaufAuditRetentionCheckpoint,
      reason: 'nothing-deleted' | 'boundary-outside-intent',
    ): Promise<AuditRetentionFinalizeOutcome> {
      await checkpoints().updateOne(
        { scopeKey, 'pending.startedAt': doc.pending?.startedAt },
        { $set: { pending: null } },
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
  }): Promise<boolean> {
    const name = params.name ?? AUDIT_RETENTION_SWEEP_LEASE;
    const expiresAt = new Date(params.now.getTime() + params.ttlMs);
    try {
      /* Take the row if it is ours, expired, or absent (upsert). A live row held by
       * someone else matches nothing, so the upsert path collides with the unique
       * index — that duplicate-key error IS "someone else holds it". */
      const res = await leases().updateOne(
        { name, $or: [{ owner: params.owner }, { expiresAt: { $lte: params.now } }] },
        {
          $set: { owner: params.owner, expiresAt },
          $setOnInsert: { acquiredAt: params.now },
        },
        { upsert: true },
      );
      return res.matchedCount === 1 || res.upsertedCount === 1;
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) {
        return false;
      }
      throw err;
    }
  }

  async function renewAuditRetentionLease(params: {
    name?: string;
    owner: string;
    ttlMs: number;
    now: Date;
  }): Promise<boolean> {
    const name = params.name ?? AUDIT_RETENTION_SWEEP_LEASE;
    const res = await leases().updateOne(
      { name, owner: params.owner },
      { $set: { expiresAt: new Date(params.now.getTime() + params.ttlMs) } },
    );
    return res.matchedCount === 1;
  }

  async function releaseAuditRetentionLease(params: {
    name?: string;
    owner: string;
  }): Promise<void> {
    await leases().deleteOne({
      name: params.name ?? AUDIT_RETENTION_SWEEP_LEASE,
      owner: params.owner,
    });
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
