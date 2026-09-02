// [knauf] KK20-328 — types for the audit-retention checkpoint ledger.
//
// `purgeAuditLogEntries` returns an `AuditCheckpoint` that a caller must persist
// so `verifyAuditChain` can later prove the purged prefix was authorized. Upstream
// anticipates exactly this ("persisted alongside retention-job records",
// `types/auditLog.ts`) but ships no store, so the retention job owns one.
import type { Document } from 'mongoose';

export interface IKnaufAuditRetentionCheckpoint extends Document {
  /** The audit scope this checkpoint authorizes: the tenant id, or
   *  `PLATFORM_CHAIN_KEY` for platform-level entries. Deliberately keyed by tenant
   *  rather than by upstream's `chainKey`, whose `tenant:` prefix is a private
   *  constant this package must not duplicate. Unique. */
  scopeKey: string;
  /** The purge covered entries up to and including this `seq`. */
  throughSeq: number;
  /** Hash the purged prefix ended on — the surviving first entry's `prevHash`. */
  prevHash: string;
  /** When the purge that minted this checkpoint ran. */
  purgedAt: Date;
  /** Cumulative rows this scope has had purged. Operational signal only. */
  totalDeleted: number;
}
// End [knauf]
