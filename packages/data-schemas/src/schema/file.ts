import mongoose, { Schema } from 'mongoose';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { IMongoFile } from '~/types';

const file: Schema<IMongoFile> = new Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      required: true,
    },
    conversationId: {
      type: String,
      ref: 'Conversation',
      index: true,
    },
    messageId: {
      type: String,
      index: true,
    },
    file_id: {
      type: String,
      index: true,
      required: true,
    },
    temp_file_id: {
      type: String,
    },
    bytes: {
      type: Number,
      required: true,
    },
    filename: {
      type: String,
      required: true,
    },
    filepath: {
      type: String,
      required: true,
    },
    object: {
      type: String,
      required: true,
      default: 'file',
    },
    embedded: {
      type: Boolean,
    },
    type: {
      type: String,
      required: true,
    },
    text: {
      type: String,
    },
    context: {
      type: String,
    },
    usage: {
      type: Number,
      required: true,
      default: 0,
    },
    source: {
      type: String,
      default: FileSources.local,
    },
    model: {
      type: String,
    },
    width: Number,
    height: Number,
    metadata: {
      fileIdentifier: String,
    },
    expiresAt: {
      type: Date,
      expires: 3600, // 1 hour in seconds
    },
    tenantId: {
      type: String,
      index: true,
    },
    // [knauf] KK20-204 — per-user content-hash deduplication.
    // knauf_content_hash = SHA-256 of the uploaded bytes (per-user dedup key).
    // knauf_canonical_file_id, when set, marks this row as a POINTER that reuses
    // the canonical row's blob + embeddings; the canonical row leaves it unset.
    // See knauf/docs/proposals/file-dedup-content-hash.md.
    knauf_content_hash: {
      type: String,
    },
    knauf_canonical_file_id: {
      type: String,
    },
    // End [knauf]
  },
  {
    timestamps: true,
  },
);

file.index({ createdAt: 1, updatedAt: 1 });
file.index(
  { filename: 1, conversationId: 1, context: 1, tenantId: 1 },
  { unique: true, partialFilterExpression: { context: FileContext.execute_code } },
);
// [knauf] KK20-204 — per-user dedup lookup on upload + content-hash-group refcount
// at delete. Non-unique (a group = the canonical + N pointers share (user, hash));
// partial so legacy rows without a hash never enter the index.
file.index(
  { user: 1, knauf_content_hash: 1 },
  { partialFilterExpression: { knauf_content_hash: { $exists: true } } },
);
// End [knauf]

export default file;
