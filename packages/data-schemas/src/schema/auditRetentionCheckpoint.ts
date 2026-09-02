// [knauf] KK20-328 — trust boundary minted by the audit-retention purge.
//
// One document per audit scope. Deliberately NOT tenant-isolated: `scopeKey` IS
// the tenant discriminator, and the retention worker sweeps every scope as a
// system job — the same privileged framing that lets `purgeAuditLogEntries`
// bypass the append-only hooks.
//
// Unlike the audit log itself this collection is mutable: each purge advances the
// boundary for its chain, so the row is upserted rather than appended.
import { Schema } from 'mongoose';
import type { IKnaufAuditRetentionCheckpoint } from '~/types';

const auditRetentionCheckpointSchema: Schema<IKnaufAuditRetentionCheckpoint> =
  new Schema<IKnaufAuditRetentionCheckpoint>(
    {
      scopeKey: { type: String, required: true, unique: true, index: true },
      throughSeq: { type: Number, required: true },
      prevHash: { type: String, required: true },
      purgedAt: { type: Date, required: true },
      totalDeleted: { type: Number, required: true, default: 0 },
    },
    { timestamps: true },
  );

export default auditRetentionCheckpointSchema;
// End [knauf]
