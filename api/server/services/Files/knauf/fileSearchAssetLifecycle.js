// [knauf] KK20-195 WP3b — the FileAsset lifecycle steps of a file_search
// upload (hardened plan §6.1). DI-style (the caller passes `db`, the
// createMethods surface) so the pieces unit-test against a real Mongo without
// mocking the world.
//
// Both flag states share the trunk: reserve (physical identity BEFORE any
// physical work) → pending logical File → blob → markQueued. They differ only after:
//   flag OFF (sync, rollout step 4): claim THIS asset, embed in-request,
//     activate generation. Cleanup remains generation-scoped; failed cleanup
//     keeps durable FileAsset/File recovery anchors.
//   flag ON (async acceptance): no embed in-request; respond 202 with the
//     indexing projection; the dedicated worker (WP4) drains the queue.

const { buildDedupKey } = require('./dedupKey');
const { getIndexProfile } = require('./asyncIndexingConfig');

// [knauf] KK20-195 review — a non-terminal asset is only a genuine in-flight
// conflict while its owner is alive. A crashed upload (flags-off: no worker
// and no reconciler to reap it) otherwise leaves the dedup slot wedged behind
// a permanent `file_indexing_in_progress` 409 for that (user, content) — so a
// provably-abandoned reservation is reclaimable: `processing` past its lease,
// or `uploading`/`queued` idle longer than the reclaim window. Fresh work is
// still protected — the lease guards a live sync/worker embed, and the window
// is far longer than any legitimate uploading/queued dwell.
const RECLAIM_STALE_MS =
  Number.parseInt(process.env.KNAUF_ASSET_RECLAIM_STALE_MS ?? '', 10) || 15 * 60 * 1000;

/**
 * True when a non-terminal asset has no live owner and can be re-driven.
 * @param {{ status: string, lease_expires_at?: Date | null, updatedAt?: Date | null }} asset
 * @param {Date} now
 * @returns {boolean}
 */
function isAbandonedNonTerminal(asset, now) {
  const nowMs = now.getTime();
  if (asset.status === 'processing') {
    return asset.lease_expires_at != null && new Date(asset.lease_expires_at).getTime() <= nowMs;
  }
  if (asset.status === 'uploading' || asset.status === 'queued') {
    const updatedAtMs = asset.updatedAt != null ? new Date(asset.updatedAt).getTime() : null;
    return updatedAtMs != null && updatedAtMs <= nowMs - RECLAIM_STALE_MS;
  }
  return false;
}

/**
 * Reserve (find-or-create) the physical asset for this upload — the dedup
 * reservation happens BEFORE blob upload and embed, so concurrent identical
 * uploads coalesce on one asset instead of both embedding (plan failure
 * mode 6).
 *
 * @param {Object} params
 * @param {Object} params.db - createMethods surface (reserveAsset, ...)
 * @param {string} params.userId
 * @param {string} params.asset_id - immutable physical UUID, independent of the logical File id
 * @param {string | undefined} params.entityId - agent id on the agent-library path
 * @param {boolean} params.messageAttachment - chat (true) vs agent library (false)
 * @param {string | undefined} params.contentHash
 * @param {boolean} params.azureSearchForAgents
 * @param {number} [params.bytes] - expected upload size; reserved for the byte-cap admission (F9)
 * @returns {Promise<{ asset: Object, created: boolean, dedupKey?: string }>}
 */
async function reserveForUpload({
  db,
  userId,
  asset_id,
  entityId,
  messageAttachment,
  contentHash,
  azureSearchForAgents,
  bytes,
}) {
  const isAgent = !messageAttachment;
  const dedupKey =
    !isAgent && contentHash ? buildDedupKey({ user: userId, contentHash }) : undefined;
  const { asset, created } = await db.reserveAsset({
    asset_id,
    scope_type: isAgent ? 'agent' : 'user',
    scope_id: isAgent ? String(entityId ?? userId) : userId,
    target_index_profile: getIndexProfile(),
    vector_backend: isAgent && azureSearchForAgents ? 'azure_search' : 'pgvector',
    embed_route: isAgent ? '/agent/embed' : '/embed',
    content_hash: contentHash,
    dedup_key: dedupKey,
    // KK20-195 review F9 — carry the expected size so a concurrent contender's
    // byte-cap check sees this reservation's bytes before its blob is stored.
    reserved_bytes: Number.isFinite(bytes) ? bytes : undefined,
  });
  return { asset, created, dedupKey };
}

/**
 * The existing-asset branch table (plan §6.1). Only meaningful when the
 * reservation found an asset instead of creating one.
 * @param {{ status: string, active_index_profile?: string | null, delete_requested_at?: Date | null, lease_expires_at?: Date | null, updatedAt?: Date | null }} asset
 * @param {{ now?: Date, reclaimable?: boolean }} [options] - `reclaimable` gates
 *   upload-path reclaim to the flags-off world; when the worker is enabled its
 *   expired-lease re-claim + the reconciler own recovery, so the upload path
 *   must NOT delete a stale asset out from under them (that would discard
 *   in-flight worker work and legitimately-queued backlog).
 * @returns {'reuse' | 'reuse_stale_profile' | 'in_progress' | 'reclaim' | 'retry_failed' | 'deleting'}
 */
function classifyExistingAsset(asset, { now = new Date(), reclaimable = true } = {}) {
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
  // uploading | queued | processing: a live owner is a genuine conflict, but a
  // provably-abandoned reservation is reclaimable (else it wedges the dedup
  // slot behind a permanent 409 with no worker/reconciler to reap it) — only
  // when nothing else will reap it (flags off; see `reclaimable`).
  if (reclaimable && isAbandonedNonTerminal(asset, now)) {
    return 'reclaim';
  }
  return 'in_progress';
}

function shouldRecoverStaleSyncReplay({ asset, asyncAccepted, workerEnabled, now = new Date() }) {
  return (
    !asyncAccepted &&
    !workerEnabled &&
    asset != null &&
    classifyExistingAsset(asset, { now, reclaimable: true }) === 'reclaim'
  );
}

function shouldRecoverIncompleteFinalization({ asset, file }) {
  return (
    file?.knauf_upload_finalized === false &&
    asset?.status === 'ready' &&
    asset?.active_generation != null &&
    asset?.delete_requested_at == null
  );
}

/**
 * Synchronous (flag-off) execution through the same generation-safe RAG
 * contract as the worker. Compensation is permitted only after the
 * token-fenced failure transition confirms this request still owns the claim.
 *
 * @param {Object} params
 * @param {Object} params.db
 * @param {string} params.asset_id
 * @param {boolean} params.createdThisRequest
 * @param {(target: { generation: number, index_profile: string }) => Promise<Object>} params.embed
 * @param {(target: { generation: number, index_profile: string }) => Promise<void>} params.cleanupGeneration
 * @param {number} [params.leaseMs]
 * @param {{ warn: Function }} params.logger
 * @returns {Promise<Object>} the embed result
 */
async function recordSyncEmbed({
  db,
  asset_id,
  createdThisRequest,
  embed,
  cleanupGeneration,
  leaseMs = 10 * 60 * 1000,
  logger,
}) {
  const claim = await db.claimAsset({ asset_id, workerId: 'sync-request', leaseMs });
  if (!claim) {
    const conflict = new Error('file_indexing_in_progress');
    conflict.knaufCode = 'file_indexing_in_progress';
    conflict.knaufPreserveLifecycle = true;
    throw conflict;
  }

  const target = {
    generation: claim.target_generation,
    index_profile: claim.target_index_profile,
  };

  const recordCleanupDebt = async (error, cleanupError) => {
    error.knaufPreserveLifecycle = true;
    let debtRecorded = false;
    try {
      debtRecorded = await db.recordStaleGeneration({
        asset_id,
        generation: claim.target_generation,
      });
    } catch (ledgerError) {
      logger?.warn(
        `[fileSearchAssetLifecycle][alert][cleanup_debt_write_failed] ${asset_id}:${claim.target_generation}: ${ledgerError?.message}`,
      );
    }
    if (debtRecorded) {
      error.knaufCleanupDeferred = true;
    } else {
      // The pending File row still carries this physical asset id, so the
      // orphan remains observable even if the asset disappeared concurrently.
      error.knaufCleanupDebtUnconfirmed = true;
      logger?.warn(
        `[fileSearchAssetLifecycle][alert][cleanup_debt_unconfirmed] ${asset_id}:${claim.target_generation}`,
      );
    }
    logger?.warn(
      `[fileSearchAssetLifecycle] generation cleanup failed for ${asset_id}:${claim.target_generation}; debtRecorded=${debtRecorded}: ${cleanupError?.message}`,
    );
  };

  const cleanTargetGeneration = async (error) => {
    try {
      await cleanupGeneration(target);
      error.knaufGenerationCleanupConfirmed = true;
    } catch (cleanupError) {
      await recordCleanupDebt(error, cleanupError);
    }
  };

  try {
    const embeddingResult = await embed(target);
    const activated = await db.activateGeneration({
      asset_id,
      execution_token: claim.execution_token,
      target_generation: claim.target_generation,
      target_index_profile: claim.target_index_profile,
    });
    if (!activated) {
      const lost = new Error('file_indexing_activation_lost');
      lost.knaufCode = 'file_indexing_activation_lost';
      // Another claimant or a delete fence owns the asset now. Clean only our
      // generation and never tombstone/remove the winner's ledger or blob.
      lost.knaufPreserveLifecycle = true;
      await cleanTargetGeneration(lost);
      throw lost;
    }
    return embeddingResult;
  } catch (error) {
    // A claimed generation is immutable and unique to this attempt. Clean it
    // after every failed attempt, including recovered assets and ownership
    // loss; a successor can only write a different generation number.
    if (!error.knaufGenerationCleanupConfirmed) {
      await cleanTargetGeneration(error);
    }
    try {
      const failedByOwner = await db.failClaim({
        asset_id,
        execution_token: claim.execution_token,
        error_code: 'embed_failed_sync',
        error_detail: error?.message,
      });
      if (!failedByOwner) {
        error.knaufPreserveLifecycle = true;
      }
      if (createdThisRequest && failedByOwner && !error.knaufPreserveLifecycle) {
        error.knaufOwnedFailure = true;
      }
    } catch (cleanupError) {
      logger?.warn(
        `[fileSearchAssetLifecycle][alert][claim_failure_record_failed] ${asset_id}: ${cleanupError?.message}`,
      );
      error.knaufPreserveLifecycle = true;
    }
    throw error;
  }
}

/**
 * The `indexing` projection added to upload responses (superset body — the
 * flat TFile spread stays for current clients; plan §6.2 fields as siblings).
 * @param {{ status?: string, active_generation?: number | null, delete_requested_at?: Date | null, last_error_code?: string | null, queued_at?: Date, blob?: { path?: string } } | null | undefined} asset
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
    retryable: asset.status === 'failed' && Boolean(asset.blob?.path),
    error_code: asset.last_error_code ?? null,
    queued_at: asset.queued_at ?? null,
  };
}

module.exports = {
  reserveForUpload,
  classifyExistingAsset,
  shouldRecoverStaleSyncReplay,
  shouldRecoverIncompleteFinalization,
  recordSyncEmbed,
  buildIndexingProjection,
};
// End [knauf]
