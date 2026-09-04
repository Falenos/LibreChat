// [knauf] KK20-328 — model factories for the audit-retention ledger.
import type { Model } from 'mongoose';
import type { IKnaufAuditRetentionCheckpoint, IKnaufAuditRetentionLease } from './types';
import { auditRetentionCheckpointSchema, auditRetentionLeaseSchema } from './schema';

export function createAuditRetentionCheckpointModel(
  mongoose: typeof import('mongoose'),
): Model<IKnaufAuditRetentionCheckpoint> {
  return (
    (mongoose.models.KnaufAuditRetentionCheckpoint as Model<IKnaufAuditRetentionCheckpoint>) ||
    mongoose.model<IKnaufAuditRetentionCheckpoint>(
      'KnaufAuditRetentionCheckpoint',
      auditRetentionCheckpointSchema,
    )
  );
}

export function createAuditRetentionLeaseModel(
  mongoose: typeof import('mongoose'),
): Model<IKnaufAuditRetentionLease> {
  return (
    (mongoose.models.KnaufAuditRetentionLease as Model<IKnaufAuditRetentionLease>) ||
    mongoose.model<IKnaufAuditRetentionLease>('KnaufAuditRetentionLease', auditRetentionLeaseSchema)
  );
}
// End [knauf]
