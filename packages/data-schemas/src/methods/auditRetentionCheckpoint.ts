// [knauf] KK20-328 — read/advance the audit-retention trust boundary.
//
// `purgeAuditLogEntries` mints a checkpoint but persists nothing; without a
// store, `verifyAuditChain` reports `ok: false` ("prefix purged or deleted") on
// every chain the retention job has touched — a false tamper alarm on a security
// feature. These methods are that store.
import type { Model } from 'mongoose';
import type { AuditCheckpoint, IKnaufAuditRetentionCheckpoint } from '~/types';
import { PLATFORM_CHAIN_KEY } from '~/schema/auditLog';

/**
 * Scope key for a tenant, or the platform sentinel. Both the retention sweep
 * (writing) and chain verification (reading) go through this, so the two can
 * never disagree.
 *
 * Tenant ids are namespaced with `SCOPE_TENANT_PREFIX` for the same reason
 * upstream namespaces its own chain keys: without it a tenant literally named
 * `__platform__` would share the platform scope's checkpoint document, and one
 * of the two would be left with a boundary from the other's chain — a permanent
 * verification failure. This is a private key space (never compared against
 * upstream's `chainKey`), so it deliberately does not reuse upstream's prefix.
 */
const SCOPE_TENANT_PREFIX = 'scope:tenant:';

export function auditRetentionScopeKey(tenantId?: string): string {
  return typeof tenantId === 'string' && tenantId.trim().length > 0
    ? `${SCOPE_TENANT_PREFIX}${tenantId}`
    : PLATFORM_CHAIN_KEY;
}

/** Explicit return type: `--isolatedDeclarations` rejects the inferred shorthand
 *  object this factory returns (same trap documented in `models/index.ts`). */
export interface AuditRetentionCheckpointMethods {
  getAuditRetentionCheckpoint(scopeKey: string): Promise<AuditCheckpoint | undefined>;
  advanceAuditRetentionCheckpoint(params: {
    scopeKey: string;
    checkpoint: AuditCheckpoint;
    purgedAt: Date;
    deletedCount: number;
  }): Promise<void>;
  clearAuditRetentionCheckpoint(scopeKey: string): Promise<void>;
}

export function createAuditRetentionCheckpointMethods(
  mongoose: typeof import('mongoose'),
): AuditRetentionCheckpointMethods {
  function model(): Model<IKnaufAuditRetentionCheckpoint> {
    return mongoose.models.KnaufAuditRetentionCheckpoint as Model<IKnaufAuditRetentionCheckpoint>;
  }

  /** The trust boundary for a scope, or undefined when it has never been purged
   *  (in which case the chain must still start at genesis). */
  async function getAuditRetentionCheckpoint(
    scopeKey: string,
  ): Promise<AuditCheckpoint | undefined> {
    const doc = await model()
      .findOne({ scopeKey })
      .select('throughSeq prevHash')
      .lean<{ throughSeq: number; prevHash: string }>();
    return doc ? { throughSeq: doc.throughSeq, prevHash: doc.prevHash } : undefined;
  }

  /**
   * Advance a chain's boundary after a purge that actually deleted rows.
   *
   * Guarded to move forward only: a stale or out-of-order writer must never walk
   * the boundary backwards, because a lower `throughSeq` would stop legitimizing
   * a prefix already purged and re-break verification. `$max`-style guarding is
   * expressed as a filter so a losing write is a no-op rather than an error.
   */
  async function advanceAuditRetentionCheckpoint(params: {
    scopeKey: string;
    checkpoint: AuditCheckpoint;
    purgedAt: Date;
    deletedCount: number;
  }): Promise<void> {
    const { scopeKey, checkpoint, purgedAt, deletedCount } = params;
    await model().updateOne(
      { scopeKey, throughSeq: { $lt: checkpoint.throughSeq } },
      {
        $set: {
          throughSeq: checkpoint.throughSeq,
          prevHash: checkpoint.prevHash,
          purgedAt,
        },
        $inc: { totalDeleted: deletedCount },
      },
      { upsert: false },
    );

    /* First purge for this chain: no row to advance, so create one. The unique
     * index on `scopeKey` makes a concurrent double-create fail rather than
     * duplicate; treat that as the other writer having won. */
    const existing = await model().exists({ scopeKey });
    if (!existing) {
      try {
        await model().create({
          scopeKey,
          throughSeq: checkpoint.throughSeq,
          prevHash: checkpoint.prevHash,
          purgedAt,
          totalDeleted: deletedCount,
        });
      } catch (err) {
        if ((err as { code?: number })?.code !== 11000) throw err;
      }
    }
  }

  /**
   * Drop a scope's boundary. Used when a purge emptied the chain: `recordAuditEntry`
   * restarts an empty chain at `seq 1` with `prevHash = GENESIS`, which verifies on
   * its own — but a leftover far-ahead checkpoint would then fail the forward-only
   * guard on every subsequent purge, pinning the scope at `ok:false` with no
   * self-heal. Clearing it lets the chain verify from genesis again.
   */
  async function clearAuditRetentionCheckpoint(scopeKey: string): Promise<void> {
    await model().deleteOne({ scopeKey });
  }

  return {
    getAuditRetentionCheckpoint,
    advanceAuditRetentionCheckpoint,
    clearAuditRetentionCheckpoint,
  };
}
// End [knauf]
