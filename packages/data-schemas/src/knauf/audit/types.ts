// [knauf] KK20-328 — types for the audit-retention ledger (checkpoints + sweep lease).
//
// `purgeAuditLogEntries` (upstream) deletes a contiguous `seq` prefix and returns a
// checkpoint that a caller must persist so `verifyAuditChain` can later tell an
// authorized retention purge from an attacker deleting the oldest rows. Upstream
// ships no store for it, so the retention job owns one.
//
// THREAT MODEL — read before trusting this ledger for anything:
// The checkpoint is a mutable document in the same database and under the same
// application credential as the audit rows. Its purpose is to distinguish an
// AUTHORIZED, intended purge (retention, full expiry) from ACCIDENTAL loss and from
// deletion by someone who can delete rows but does NOT hold the checkpoint signing
// key. It is NOT tamper-proof against an attacker holding the application Mongo
// credential AND the signing key — but neither is the upstream hash chain itself:
// with the write credential an attacker can truncate the tail undetected. Setting
// `KNAUF_AUDIT_CHECKPOINT_HMAC_KEY` (kept outside Mongo, e.g. Key Vault) raises the
// bar to "Mongo credential is not enough"; an independently protected / WORM copy of
// the checkpoint is the platform's job and is tracked as a rollout prerequisite.
import type { Document } from 'mongoose';

/** A boundary the purge intends to, or did, delete through. */
export interface AuditRetentionBoundary {
  /** Entries up to and including this `seq` are (to be) gone. */
  throughSeq: number;
  /** Hash the purged prefix ends on — the surviving first entry's `prevHash`, or
   *  the last entry's own `hash` when the purge empties the chain. */
  prevHash: string;
  /** The purge empties the chain. Upstream's `recordAuditEntry` then restarts the
   *  chain at `seq 1` from genesis — a new GENERATION of the same scope. */
  terminal: boolean;
}

/** A purge that was announced (write-ahead) but not yet committed. */
export interface AuditRetentionPendingPurge extends AuditRetentionBoundary {
  startedAt: Date;
  cutoff: Date;
}

export interface IKnaufAuditRetentionCheckpoint extends Document {
  /** Tenant scope key (`scope:tenant:<id>`) or the platform sentinel. Unique. */
  scopeKey: string;
  /** Increments each time a terminal purge empties the chain and it restarts at
   *  genesis. An empty chain WITH a terminal checkpoint is an authorized full
   *  expiry; an empty chain WITHOUT one is unexplained. */
  generation: number;
  throughSeq: number;
  prevHash: string;
  terminal: boolean;
  /** When the last committed purge ran. Unset until the first commit. */
  purgedAt?: Date;
  /** Cumulative rows purged in this scope (operational signal; may undercount
   *  purges that were recovered after a crash, see `recoveredCommits`). */
  totalDeleted: number;
  /** Commits performed by crash-recovery rather than the purging process. */
  recoveredCommits: number;
  /** HMAC-SHA256 over the canonical committed fields, when a signing key is set. */
  signature?: string;
  /** Write-ahead intent. Present between `begin` and `finalize`. */
  pending?: AuditRetentionPendingPurge | null;
}

/** Lease document: one row per singleton job name. */
export interface IKnaufAuditRetentionLease extends Document {
  name: string;
  owner: string;
  acquiredAt: Date;
  expiresAt: Date;
}

/** What callers (sweep, admin verify) read back. Plain object, no Document. */
export interface AuditRetentionCheckpointState {
  scopeKey: string;
  generation: number;
  throughSeq: number;
  prevHash: string;
  terminal: boolean;
  purgedAt?: Date;
  totalDeleted: number;
  recoveredCommits: number;
  signature?: string;
  pending?: AuditRetentionPendingPurge | null;
}

export type AuditRetentionFinalizeOutcome =
  | { action: 'none'; reason: 'no-pending' }
  | { action: 'dropped'; reason: 'nothing-deleted' | 'boundary-outside-intent' | 'lost-race' }
  | {
      action: 'committed';
      boundary: AuditRetentionBoundary;
      generation: number;
      recovered: boolean;
    };
// End [knauf]
