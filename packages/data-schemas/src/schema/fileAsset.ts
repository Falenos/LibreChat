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
    // KK20-195 review R1 — tenant isolation. `applyTenantIsolation` injects
    // tenantId into every tenant-scoped query (including the reservation
    // upsert); without this path, strict mode threw StrictModeError on any
    // tenant-aware upload. Optional: single-tenant deployments carry none.
    tenantId: {
      type: String,
      index: true,
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
    // KK20-195 review R9 — cleanup debt: generations whose RAG delete failed
    // (or that a lost claim wrote and could not clean). Recorded token-less
    // ($addToSet — additive, never part of the state machine) and drained by
    // the reconciler; final deletion also removes every listed generation.
    stale_generations: {
      type: [Number],
      default: [],
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
// At most one asset per (tenant, dedup key) — dedup keys never coalesce
// across tenants (KK20-195 review R1); partial so non-deduped
// (agent-library) assets never enter the index. Absent tenantId indexes as
// null, which keeps single-tenant deployments on one uniqueness domain.
fileAssetSchema.index(
  { tenantId: 1, dedup_key: 1 },
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
// [knauf] KK20-195 review — admission counters (countActiveByScope /
// sumActiveBytesByScope) filter by authorization scope + status; without this
// each upload scanned every tenant's non-terminal assets via the status prefix.
fileAssetSchema.index({ scope_type: 1, scope_id: 1, status: 1 });
// Reconciler invariant sweeps (cases 6 & 7): bound the scan to the (near-zero)
// matches instead of walking the whole ready/failed steady state every pass.
fileAssetSchema.index({ status: 1, active_generation: 1 });
fileAssetSchema.index({ status: 1, last_error_code: 1 });
// KK20-195 review R9 — cleanup-debt sweep (multikey; near-zero cardinality).
fileAssetSchema.index({ stale_generations: 1 });

export default fileAssetSchema;
// End [knauf]
