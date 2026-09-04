// [knauf] KK20-328 — schemas for the audit-retention checkpoint ledger and sweep lease.
//
// One checkpoint document per audit scope. Deliberately NOT tenant-isolated:
// `scopeKey` IS the tenant discriminator, and the retention sweep runs every scope
// as a system job — the same privileged framing that lets `purgeAuditLogEntries`
// bypass the append-only hooks. Mutable by design (see types.ts THREAT MODEL): a
// purge advances the boundary in place; the audit rows themselves stay immutable.
import { Schema } from 'mongoose';
import type { IKnaufAuditRetentionCheckpoint, IKnaufAuditRetentionLease } from './types';

const pendingSchema = new Schema(
  {
    throughSeq: { type: Number, required: true },
    prevHash: { type: String, required: true },
    terminal: { type: Boolean, required: true },
    startedAt: { type: Date, required: true },
    cutoff: { type: Date, required: true },
  },
  { _id: false },
);

export const auditRetentionCheckpointSchema: Schema<IKnaufAuditRetentionCheckpoint> =
  new Schema<IKnaufAuditRetentionCheckpoint>(
    {
      scopeKey: { type: String, required: true, unique: true, index: true },
      generation: { type: Number, required: true, default: 1 },
      throughSeq: { type: Number, required: true, default: 0 },
      prevHash: { type: String, required: true },
      terminal: { type: Boolean, required: true, default: false },
      purgedAt: { type: Date },
      totalDeleted: { type: Number, required: true, default: 0 },
      recoveredCommits: { type: Number, required: true, default: 0 },
      signature: { type: String },
      pending: { type: pendingSchema, default: null },
    },
    { timestamps: true },
  );

/** A single-document lease per job name. `expiresAt` is compared against the
 *  caller-supplied clock, never a TTL index, so an expired lease is taken over
 *  atomically by the next acquirer rather than deleted by a background monitor. */
export const auditRetentionLeaseSchema: Schema<IKnaufAuditRetentionLease> =
  new Schema<IKnaufAuditRetentionLease>(
    {
      name: { type: String, required: true, unique: true, index: true },
      owner: { type: String, required: true },
      acquiredAt: { type: Date, required: true },
      expiresAt: { type: Date, required: true },
    },
    { timestamps: false },
  );
// End [knauf]
