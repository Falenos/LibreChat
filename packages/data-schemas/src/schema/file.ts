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
    storageKey: {
      type: String,
    },
    storageRegion: {
      type: String,
    },
    // [knauf] NO-TICKET — physical owner when `source` carries logical processing semantics.
    storageSource: {
      type: String,
    },
    // End [knauf]
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
    textFormat: {
      /* 'html' when the backend produced a sanitized HTML preview
       * (office-type CDN/mammoth output), 'text' for plain-text
       * extracts (RAG / pdf-parse / mammoth.extractRawText). Clients
       * gate office-bucket routing on textFormat === 'html' to
       * prevent injecting RAG-extracted plain text into the iframe
       * as HTML. See Codex P1 review on PR #12934. */
      type: String,
      enum: ['html', 'text'],
    },
    status: {
      /* Deferred-preview code-execution flow: the immediate persist
       * step writes the record with 'pending'; the background render
       * (HTML extraction) updates to 'ready' or 'failed'. Absent on
       * legacy records and on file kinds that never expect a preview. */
      type: String,
      enum: ['pending', 'ready', 'failed'],
      index: true,
    },
    previewError: {
      type: String,
      /* Bounded to short machine-readable reasons (`'timeout'`,
       * `'parser-error'`, `'orphaned'`, `'unexpected'`). Cap prevents a
       * future codepath from accidentally persisting a stack trace or
       * full error message — would bloat documents and ship a wall of
       * text into the UI tooltip. */
      maxlength: 200,
    },
    previewRevision: {
      /* Generation marker for the deferred-preview lifecycle. Stamped
       * by the immediate persist step on every emit (each new emit
       * gets a fresh UUID); the deferred preview render's `updateFile`
       * only commits when the marker still matches what it was when
       * extraction started. Without this, two turns reusing the same
       * `(filename, conversationId)` share a `file_id`, and an older
       * render finishing after a newer one would silently overwrite
       * the newer record with stale `text`/`status`. (Codex P1 review
       * on PR #12957.) */
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
      codeEnvRef: {
        type: new Schema(
          {
            kind: {
              type: String,
              enum: ['skill', 'agent', 'user'],
              required: true,
            },
            id: { type: String, required: true },
            storage_session_id: { type: String, required: true },
            file_id: { type: String, required: true },
            version: { type: Number },
          },
          { _id: false },
        ),
        default: undefined,
      },
    },
    expiresAt: {
      /* Short-lived upload TTL managed by MongoDB. This is separate from
       * retention-scoped `expiredAt`, which is swept by application code
       * after storage cleanup succeeds. */
      type: Date,
      expires: 3600, // 1 hour in seconds
    },
    tenantId: {
      type: String,
      index: true,
    },
    // [knauf] KK20-204 — per-user content-hash deduplication.
    // knauf_content_hash = SHA-256 of the uploaded bytes (per-user dedup key).
    // knauf_asset_id = the file_id under which the shared blob + embeddings
    // physically live. Set on EVERY deduped row: the embed owner stores its own
    // file_id; reuse rows store the owner's file_id. Keying the asset by a stable
    // id (not an elected, deletable "canonical" row) means deleting any single row
    // never orphans the asset or forces a re-embed. See
    // knauf/docs/proposals/file-dedup-content-hash.md.
    knauf_content_hash: {
      type: String,
    },
    knauf_asset_id: {
      type: String,
    },
    // knauf_dedup_owner marks the single row per (user, content_hash) that first
    // embedded the asset. The unique partial index below enforces "at most one
    // owner per group" — a concurrent first-upload that loses the race inserts a
    // non-owner row instead (its own embedding is a transient duplicate the
    // delete-time group GC reclaims). Used to detect/instrument the race; retrieval
    // and GC key on knauf_asset_id, not this flag.
    knauf_dedup_owner: {
      type: Boolean,
    },
    // End [knauf]
    // [knauf] KK20-195 WP2 — client-generated batch id shared by every file of a
    // multi-file selection; drives the aggregate batch-status projection. The
    // batch id alone is NEVER authorization — queries are always owner-scoped
    // (see the compound index below). Optional for single-file uploads.
    knauf_upload_batch_id: {
      type: String,
    },
    // False only for the crash-recovery marker written before physical work;
    // true after agent binding, retention, and final metadata are durable.
    knauf_upload_finalized: {
      type: Boolean,
    },
    // End [knauf]
    expiredAt: {
      /* Retention deadline for persisted files. The file sweep deletes the
       * backing storage first, then removes this metadata record. */
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

file.index({ expiredAt: 1 });
file.index({ createdAt: 1, updatedAt: 1 });
file.index(
  { filename: 1, conversationId: 1, context: 1, tenantId: 1 },
  { unique: true, partialFilterExpression: { context: FileContext.execute_code } },
);
// [knauf] KK20-204 — per-user dedup lookup on upload + content-hash-group refcount
// at delete. Non-unique (a group = the embed owner + N reuse rows share (user,
// hash)); partial so legacy rows without a hash never enter the index.
file.index(
  { user: 1, knauf_content_hash: 1 },
  { partialFilterExpression: { knauf_content_hash: { $exists: true } } },
);
// Unique-owner invariant: at most one embed-owner per (user, content-hash). A
// concurrent first-upload that loses this race fails the insert with a duplicate-key
// error and falls back to a non-owner row (handled in processAgentFileUpload). The
// knauf_dedup_owner key disambiguates this key pattern from the lookup index above.
file.index(
  { user: 1, knauf_content_hash: 1, knauf_dedup_owner: 1 },
  { unique: true, partialFilterExpression: { knauf_dedup_owner: true } },
);
// End [knauf]
// [knauf] KK20-195 WP2 — async-indexing lookups.
// Batch-status projection: compound index STARTS with the owner scope and ends
// with the batch id (hardened plan §4.1: never query a batch id globally).
file.index(
  { user: 1, knauf_upload_batch_id: 1 },
  { partialFilterExpression: { knauf_upload_batch_id: { $exists: true } } },
);
// Reference recount (last-reference delete) + list-API status hydration key on
// knauf_asset_id across a user's rows; partial so legacy rows stay out.
file.index(
  { knauf_asset_id: 1 },
  { partialFilterExpression: { knauf_asset_id: { $exists: true } } },
);
// End [knauf]

export default file;
