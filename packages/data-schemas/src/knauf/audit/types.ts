// [knauf] KK20-328 — types for the audit-retention ledger (checkpoints + sweep lease).
//
// `purgeAuditLogEntries` (upstream) deletes a contiguous `seq` prefix and returns a
// checkpoint that a caller must persist so `verifyAuditChain` can later tell an
// authorized retention purge from an attacker deleting the oldest rows. Upstream
// ships no store for it, so the retention job owns one.
//
// DESIGN RULE — retention never empties a chain. The newest row is always retained as
// the chain's anchor, so a checkpoint is always `{ throughSeq, prevHash }` exactly as
// upstream mints it, the upstream delete is always bounded by a retained `seq`, and an
// EMPTY chain is unexplained by construction (retention cannot produce one). The cost
// is one most-recent admin row that may outlive the retention window until a newer row
// supersedes it; that row is the tamper-evidence anchor and is documented as such.
//
// THREAT MODEL — read before trusting this ledger for anything:
// The checkpoint and the write-ahead intent are mutable documents in the same
// database and under the same application credential as the audit rows. Their job
// is to distinguish an AUTHORIZED purge from ACCIDENTAL loss and from deletion by a
// party who holds the Mongo credential but NOT the signing key. With
// `KNAUF_AUDIT_CHECKPOINT_HMAC_KEY` configured (kept outside Mongo, e.g. Key Vault):
//   - every INTENT is signed at `begin` over boundary, cutoff, owner and fencing token,
//     and recovery refuses to commit or sign anything whose intent signature does not
//     verify — so a forged `pending` document is not an oracle that gets the legitimate
//     scheduler to sign a deletion it never authorized;
//   - every COMMITTED checkpoint is signed, and the admin verify endpoint ignores a
//     checkpoint whose signature is missing or invalid (and says which).
// Without the key everything is explicitly `unsigned` and only as strong as the Mongo
// credential — which is exactly as strong as the upstream hash chain itself (tail
// truncation with the write credential is undetectable). Neither is tamper-proof
// against Mongo credential + key; an independently protected / WORM copy of the
// checkpoint is the platform's job and is tracked as a rollout prerequisite.
import type { Document } from 'mongoose';

/** A boundary the purge intends to, or did, delete through. */
export interface AuditRetentionBoundary {
  /** Entries up to and including this `seq` are (to be) gone. Always < the chain's
   *  newest `seq`, because the newest row is retained. */
  throughSeq: number;
  /** Hash the purged prefix ends on — the surviving first entry's `prevHash`. */
  prevHash: string;
  /** The instant to hand to upstream's purge so that it deletes exactly this prefix:
   *  the cutoff, or the newest row's own `createdAt` when everything is older than the
   *  cutoff (which retains that row). */
  purgeBefore: Date;
}

/** A purge that was announced (write-ahead) but not yet committed. */
export interface AuditRetentionPendingPurge {
  throughSeq: number;
  prevHash: string;
  startedAt: Date;
  cutoff: Date;
  /** Lease owner and fencing token of the pass that announced it. */
  owner: string;
  fence: number;
  /** HMAC over the intent, when a signing key is configured. */
  signature?: string;
}

/** The persisted checkpoint, as callers (sweep, admin verify) read it back. */
export interface AuditRetentionCheckpointState {
  /** Audit scope key — IDENTICAL to upstream's `chainKey` (`auditChainKey(tenantId)`),
   *  so the checkpoint and the chain it describes can never disagree on partitioning. */
  scopeKey: string;
  throughSeq: number;
  prevHash: string;
  /** When the last committed purge ran. Unset until the first commit — a document
   *  without it is an intent-only record, NOT a checkpoint. */
  purgedAt?: Date;
  /** Cumulative rows purged in this scope (operational signal; recovered commits
   *  may not know their count — see `recoveredCommits`). */
  totalDeleted: number;
  /** Commits performed by crash-recovery rather than the purging process. */
  recoveredCommits: number;
  /** Highest lease fencing token that has written this document. A writer with a
   *  lower token is stale (its lease lapsed and another holder took over) and every
   *  one of its writes is rejected. */
  lastFence: number;
  /** HMAC-SHA256 over the canonical committed fields, when a signing key is set. */
  signature?: string;
  /** Write-ahead intent. Present between `begin` and `finalize`. */
  pending?: AuditRetentionPendingPurge | null;
}

export interface IKnaufAuditRetentionCheckpoint extends Document, AuditRetentionCheckpointState {}

/** Lease document: one row per singleton job name. */
export interface IKnaufAuditRetentionLease extends Document {
  name: string;
  owner: string;
  /** Monotonic fencing token; increments on every acquisition or takeover. */
  fence: number;
  acquiredAt: Date;
  expiresAt: Date;
  /** When the last holder finished a pass. Lets `acquire` refuse a redundant pass
   *  (e.g. ten replicas booting at once) without a coordinator. */
  lastCompletedAt?: Date;
}

export type AuditRetentionLeaseGrant =
  | { ok: true; fence: number }
  | { ok: false; reason: 'held' | 'recently-completed' };

export type AuditRetentionDropReason =
  /** The chain shows nothing below the announced boundary was removed. */
  | 'nothing-deleted'
  /** More is gone than the intent authorized — never legitimized. */
  | 'boundary-outside-intent'
  /** Intent signature missing/invalid under a configured key: a forged or foreign intent. */
  | 'untrusted-intent'
  /** The caller's fencing token is older than the document's — its lease lapsed. */
  | 'stale-fence'
  | 'lost-race';

export type AuditRetentionFinalizeOutcome =
  | { action: 'none'; reason: 'no-pending' }
  | { action: 'dropped'; reason: AuditRetentionDropReason }
  | { action: 'committed'; boundary: { throughSeq: number; prevHash: string }; recovered: boolean };
// End [knauf]
