// [knauf] KK20-195 WP3b — the FileAsset lifecycle steps of a file_search
// upload (hardened plan §6.1). DI-style (the caller passes `db`, the
// createMethods surface) so the pieces unit-test against a real Mongo without
// mocking the world.
//
// Both flag states share the trunk: reserve (physical identity BEFORE any
// physical work) → blob → markQueued → logical File. They differ only after:
//   flag OFF (sync, rollout step 4): claim THIS asset, embed in-request,
//     activate generation — user-visible behavior unchanged, but the asset
//     now records the whole lifecycle. On failure the asset this request
//     created is removed again (old clients expect "failure leaves nothing").
//   flag ON (async acceptance): no embed in-request; respond 202 with the
//     indexing projection; the dedicated worker (WP4) drains the queue.

const { buildDedupKey } = require('./dedupKey');
const { getIndexProfile } = require('./asyncIndexingConfig');

/**
 * Reserve (find-or-create) the physical asset for this upload — the dedup
 * reservation happens BEFORE blob upload and embed, so concurrent identical
 * uploads coalesce on one asset instead of both embedding (plan failure
 * mode 6).
 *
 * @param {Object} params
 * @param {Object} params.db - createMethods surface (reserveAsset, ...)
 * @param {string} params.userId
 * @param {string} params.file_id
 * @param {string | undefined} params.entityId - agent id on the agent-library path
 * @param {boolean} params.messageAttachment - chat (true) vs agent library (false)
 * @param {string | undefined} params.contentHash
 * @param {boolean} params.azureSearchForAgents
 * @returns {Promise<{ asset: Object, created: boolean, dedupKey?: string }>}
 */
async function reserveForUpload({
  db,
  userId,
  file_id,
  entityId,
  messageAttachment,
  contentHash,
  azureSearchForAgents,
}) {
  const isAgent = !messageAttachment;
  const dedupKey =
    !isAgent && contentHash ? buildDedupKey({ user: userId, contentHash }) : undefined;
  const { asset, created } = await db.reserveAsset({
    asset_id: file_id,
    scope_type: isAgent ? 'agent' : 'user',
    scope_id: isAgent ? String(entityId ?? userId) : userId,
    target_index_profile: getIndexProfile(),
    vector_backend: isAgent && azureSearchForAgents ? 'azure_search' : 'pgvector',
    embed_route: isAgent ? '/agent/embed' : '/embed',
    content_hash: contentHash,
    dedup_key: dedupKey,
  });
  return { asset, created, dedupKey };
}

/**
 * The existing-asset branch table (plan §6.1). Only meaningful when the
 * reservation found an asset instead of creating one.
 * @param {{ status: string, active_index_profile?: string | null, delete_requested_at?: Date | null }} asset
 * @returns {'reuse' | 'reuse_stale_profile' | 'in_progress' | 'retry_failed' | 'deleting'}
 */
function classifyExistingAsset(asset) {
  if (
    asset.delete_requested_at != null ||
    asset.status === 'deleting' ||
    asset.status === 'delete_failed'
  ) {
    return 'deleting';
  }
  if (asset.status === 'ready') {
    // A ready asset on an OLDER profile stays usable; the fenced replacement
    // re-index is wired with the worker (WP4) — nothing can drain a queued
    // replacement before it exists. Deviation from plan §6.1 recorded there.
    return asset.active_index_profile === getIndexProfile() ? 'reuse' : 'reuse_stale_profile';
  }
  if (asset.status === 'failed') {
    return 'retry_failed';
  }
  return 'in_progress'; // uploading | queued | processing
}

/**
 * Synchronous (flag-off) execution: claim THIS asset, run the embed, activate
 * the generation. On failure: token-fenced fail, and when this request
 * created the asset, remove it again (with the blob/vector compensation the
 * embed wrapper already performed) so old clients keep today's "failure
 * leaves nothing" semantics; then rethrow.
 *
 * @param {Object} params
 * @param {Object} params.db
 * @param {string} params.asset_id
 * @param {boolean} params.createdThisRequest
 * @param {() => Promise<Object>} params.embed - thunk (uploadVectors, usually via embedWithBlobCompensation)
 * @param {number} [params.leaseMs]
 * @param {{ warn: Function }} params.logger
 * @returns {Promise<Object>} the embed result
 */
async function recordSyncEmbed({
  db,
  asset_id,
  createdThisRequest,
  embed,
  leaseMs = 10 * 60 * 1000,
  logger,
}) {
  const claim = await db.claimAsset({ asset_id, workerId: 'sync-request', leaseMs });
  if (!claim) {
    // Someone else holds the claim (rare concurrent race) — surface as a
    // stable conflict rather than double-embedding.
    const conflict = new Error('file_indexing_in_progress');
    conflict.knaufCode = 'file_indexing_in_progress';
    throw conflict;
  }
  try {
    const embeddingResult = await embed();
    await db.activateGeneration({
      asset_id,
      execution_token: claim.execution_token,
      target_generation: claim.target_generation,
      target_index_profile: claim.target_index_profile,
    });
    return embeddingResult;
  } catch (error) {
    try {
      await db.failClaim({
        asset_id,
        execution_token: claim.execution_token,
        error_code: 'embed_failed_sync',
        error_detail: error?.message,
      });
      if (createdThisRequest) {
        // Blob + vectors were already compensated by the embed wrapper; the
        // reservation this request made must not linger as a failed asset the
        // (pre-WP5) client cannot see or retry.
        await db.tombstoneForDelete({ asset_id });
        await db.removeAsset({ asset_id });
      }
    } catch (cleanupError) {
      logger?.warn(
        `[fileSearchAssetLifecycle] sync-failure cleanup failed for ${asset_id}: ${cleanupError?.message}`,
      );
    }
    throw error;
  }
}

/**
 * The `indexing` projection added to upload responses (superset body — the
 * flat TFile spread stays for current clients; plan §6.2 fields as siblings).
 * @param {{ status?: string, active_generation?: number | null, delete_requested_at?: Date | null, last_error_code?: string | null, queued_at?: Date } | null | undefined} asset
 * @returns {{ status: string, ready: boolean, retryable: boolean, error_code: string | null, queued_at: Date | null }}
 */
function buildIndexingProjection(asset) {
  if (!asset) {
    return { status: 'ready', ready: true, retryable: false, error_code: null, queued_at: null };
  }
  const ready = asset.active_generation != null && asset.delete_requested_at == null;
  return {
    status: asset.status ?? 'ready',
    ready,
    retryable: asset.status === 'failed',
    error_code: asset.last_error_code ?? null,
    queued_at: asset.queued_at ?? null,
  };
}

module.exports = {
  reserveForUpload,
  classifyExistingAsset,
  recordSyncEmbed,
  buildIndexingProjection,
};
// End [knauf]
