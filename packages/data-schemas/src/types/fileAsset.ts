// [knauf] KK20-195 WP2 — types for the physical FileAsset aggregate.
// One document per physical blob/vector object; the logical `File` rows point
// at it via `knauf_asset_id`. See
// knauf/docs/implementation-plans/async-file-indexing-production.md §4.2.
import type { Document } from 'mongoose';

export type FileAssetStatus =
  | 'uploading'
  | 'queued'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'deleting'
  | 'delete_failed';

export type FileAssetVectorBackend = 'pgvector' | 'azure_search';

export type FileAssetEmbedRoute = '/embed' | '/agent/embed';

export type FileAssetScopeType = 'user' | 'agent';

export interface IFileAssetBlob {
  /** Storage source key (e.g. 'azure_blob', 'local') — never an expiring SAS URL. */
  source?: string;
  /** Stable blob path/key within the source. */
  path?: string;
  region?: string;
  bytes?: number;
  mime?: string;
  /** Sanitized original name; preserves the extension for async parser routing. */
  filename?: string;
}

export interface IKnaufFileAsset extends Document {
  /** Stable UUID; the physical identity used by blob and vectors. */
  asset_id: string;
  /** Tenant isolation scope (KK20-195 review R1); absent on single-tenant deployments. */
  tenantId?: string | null;
  /** Retrieval/dedup scope: user-owned chat vs agent-owned knowledge. */
  scope_type: FileAssetScopeType;
  scope_id: string;
  /** SHA-256 of the uploaded bytes. */
  content_hash?: string;
  /**
   * Hash of authorization/isolation scope + content hash (NO index profile —
   * hardened plan §4.2). Present only where dedup applies (chat); unique when
   * present.
   */
  dedup_key?: string;
  /** Server-selected profile desired by the current work (generation metadata). */
  target_index_profile: string;
  /** Profile of `active_generation`; null before the first successful index. */
  active_index_profile?: string | null;
  vector_backend: FileAssetVectorBackend;
  embed_route: FileAssetEmbedRoute;
  blob?: IFileAssetBlob;
  status: FileAssetStatus;
  /** Automatic execution attempts for the current desired work. */
  attempt_count: number;
  next_attempt_at?: Date;
  lease_owner?: string;
  lease_expires_at?: Date;
  /** Random token unique to one claim; fences heartbeat and terminal updates. */
  execution_token?: string;
  /** Generation assigned to the current claim. */
  target_generation: number;
  /** Only generation visible to queries; null before first successful index. */
  active_generation?: number | null;
  /** Stable bounded machine code (plan §15 taxonomy). */
  /** KK20-195 review R9 — generations whose RAG delete failed; reconciler-drained cleanup debt. */
  stale_generations?: number[];
  last_error_code?: string;
  /** Sanitized, truncated diagnostic; never document text or credentials. */
  last_error_detail?: string;
  queued_at?: Date;
  started_at?: Date;
  ready_at?: Date;
  /** Tombstone — blocks future claims/activation regardless of status. */
  delete_requested_at?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
// End [knauf]
