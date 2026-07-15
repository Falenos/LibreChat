// [knauf] KK20-195 WP2 — the physical FileAsset aggregate (collection
// `knauf_file_assets`). Owns blob, vectors, dedup, indexing, retry, retention,
// and physical deletion for one physical object; logical `File` rows reference
// it via `knauf_asset_id` and never own physical state themselves (the
// KK20-204 dedup already lets the original owner row be deleted while reuse
// rows survive). The Mongo row doubles as the durable work backlog: the
// dedicated worker claims due assets with a single atomic findOneAndUpdate —
// no multi-document transactions anywhere (plan invariant #14). See
// knauf/docs/implementation-plans/async-file-indexing-production.md §4-§5.
import { Schema } from 'mongoose';
import type { IKnaufFileAsset } from '~/types';

const fileAssetSchema: Schema<IKnaufFileAsset> = new Schema(
  {
    asset_id: {
      type: String,
      required: true,
      index: { unique: true },
    },
    scope_type: {
      type: String,
      enum: ['user', 'agent'],
      required: true,
    },
    scope_id: {
      type: String,
      required: true,
    },
    content_hash: {
      type: String,
    },
    // Authorization/isolation scope + content hash ONLY (no index profile —
    // a profile change re-indexes the SAME asset through a new generation).
    dedup_key: {
      type: String,
    },
    target_index_profile: {
      type: String,
      required: true,
    },
    active_index_profile: {
      type: String,
      default: null,
    },
    vector_backend: {
      type: String,
      enum: ['pgvector', 'azure_search'],
      required: true,
    },
    embed_route: {
      type: String,
      enum: ['/embed', '/agent/embed'],
      required: true,
    },
    // Stable blob identity — never an expiring SAS URL (plan §10).
    blob: {
      source: { type: String },
      path: { type: String },
      region: { type: String },
      bytes: { type: Number },
      mime: { type: String },
    },
    status: {
      type: String,
      enum: ['uploading', 'queued', 'processing', 'ready', 'failed', 'deleting', 'delete_failed'],
      required: true,
      default: 'uploading',
    },
    attempt_count: {
      type: Number,
      default: 0,
    },
    next_attempt_at: {
      type: Date,
    },
    lease_owner: {
      type: String,
    },
    lease_expires_at: {
      type: Date,
    },
    execution_token: {
      type: String,
    },
    target_generation: {
      type: Number,
      default: 0,
    },
    active_generation: {
      type: Number,
      default: null,
    },
    last_error_code: {
      type: String,
    },
    // Bounded — sanitized and truncated by the writer; never raw provider text.
    last_error_detail: {
      type: String,
      maxlength: 2000,
    },
    queued_at: { type: Date },
    started_at: { type: Date },
    ready_at: { type: Date },
    delete_requested_at: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true, collection: 'knauf_file_assets' },
);

// Plan §4.3 required indexes.
// At most one asset per dedup key (authorization scope + content hash);
// partial so non-deduped (agent-library) assets never enter the index.
fileAssetSchema.index(
  { dedup_key: 1 },
  { unique: true, partialFilterExpression: { dedup_key: { $exists: true } } },
);
// Normal claims: due queued work, oldest first.
fileAssetSchema.index({ status: 1, next_attempt_at: 1, queued_at: 1 });
// Stale processing claims (expired leases).
fileAssetSchema.index({ status: 1, lease_expires_at: 1 });
// Deletion reconciliation.
fileAssetSchema.index({ delete_requested_at: 1, status: 1 });
// Stale uploading / failed operational queries (timestamps => camelCase).
fileAssetSchema.index({ updatedAt: 1, status: 1 });

export default fileAssetSchema;
// End [knauf]
