// [knauf] KK20-328 — model factory for the audit-retention checkpoint ledger.
// Not tenant-isolated by design; see the schema for why.
import type { Model } from 'mongoose';
import type { IKnaufAuditRetentionCheckpoint } from '~/types';
import auditRetentionCheckpointSchema from '~/schema/auditRetentionCheckpoint';

export function createAuditRetentionCheckpointModel(
  mongoose: typeof import('mongoose'),
): Model<IKnaufAuditRetentionCheckpoint> {
  return (
    mongoose.models.KnaufAuditRetentionCheckpoint ||
    mongoose.model<IKnaufAuditRetentionCheckpoint>(
      'KnaufAuditRetentionCheckpoint',
      auditRetentionCheckpointSchema,
    )
  );
}
// End [knauf]
