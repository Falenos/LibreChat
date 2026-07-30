import mongoose, { Schema, Document, Types } from 'mongoose';
// [knauf] Persist the fork-only artifact payload beside upstream file snapshots. (NO-TICKET)
import type { SharedArtifactSnapshot, SharedFileSnapshot } from '~/types';
// End [knauf]

export interface ISharedLink extends Document {
  conversationId: string;
  title?: string;
  user?: string;
  messages?: Types.ObjectId[];
  shareId?: string;
  targetMessageId?: string;
  expiredAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
  snapshotFiles?: boolean;
  fileSnapshots?: SharedFileSnapshot[];
  // [knauf] Fork-only artifact snapshot backing artifact-only shared links. (NO-TICKET)
  knauf_artifact?: SharedArtifactSnapshot;
  // End [knauf]
}

/**
 * Immutable file snapshot embedded on a shared link. Captures the metadata the
 * share-scoped file routes need to stream/preview each referenced file without
 * consulting the original owner's live file ACL. References the original stored
 * object (no byte copy).
 */
const fileSnapshotSchema = new Schema<SharedFileSnapshot>(
  {
    file_id: { type: String, required: true },
    source: { type: String },
    storageKey: { type: String },
    filepath: { type: String },
    type: { type: String },
    filename: { type: String },
    bytes: { type: Number },
    width: { type: Number },
    height: { type: Number },
    model: { type: String },
    previewRevision: { type: String },
    tenantId: { type: String },
  },
  { _id: false },
);

// [knauf] Immutable generated-artifact payload; active content remains sandboxed by the client renderer. (NO-TICKET)
const sharedArtifactSchema = new Schema<SharedArtifactSnapshot>(
  {
    title: { type: String, required: true },
    type: { type: String, required: true },
    content: { type: String, required: true },
    language: { type: String },
  },
  { _id: false },
);
// End [knauf]

const shareSchema: Schema<ISharedLink> = new Schema(
  {
    conversationId: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      index: true,
    },
    user: {
      type: String,
      index: true,
    },
    messages: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Message' }],
    shareId: {
      type: String,
      index: true,
    },
    targetMessageId: {
      type: String,
      required: false,
      index: true,
    },
    tenantId: {
      type: String,
      index: true,
    },
    expiredAt: {
      type: Date,
    },
    snapshotFiles: {
      type: Boolean,
    },
    fileSnapshots: {
      type: [fileSnapshotSchema],
      default: undefined,
    },
    // [knauf] Artifact-only share discriminator and immutable payload. (NO-TICKET)
    knauf_artifact: {
      type: sharedArtifactSchema,
      required: false,
    },
    // End [knauf]
  },
  { timestamps: true },
);

shareSchema.index({ expiredAt: 1 }, { expireAfterSeconds: 0 });
shareSchema.index({ conversationId: 1, user: 1, targetMessageId: 1, tenantId: 1 });

export default shareSchema;
