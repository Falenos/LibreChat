// [knauf] KK20-195 WP2 — legacy backfill: one KnaufFileAsset per existing
// physical object (hardened plan §4.4, all seven steps). Batched and
// cursor-resumable (an HTTP-triggered long backfill must survive gateway
// timeouts), idempotent by natural key (upsert on asset_id — re-running any
// batch is a no-op). Never auto-embeds: known-incomplete rows map to
// `failed` + `migration_inconsistent` for an operator to triage.
//
// Legacy mapping:
//   - deduped chat rows        → one asset per distinct knauf_asset_id
//   - non-deduped / agent rows → asset_id = file_id
//   - missing File.knauf_asset_id pointers are backfilled with file_id
//   - embedded=true            → status=ready, active_generation=0 and a
//     named legacy active/target index profile (generation 0 = legacy
//     vectors whose generation field is absent; read-compat stays until an
//     explicit cleanup decision)
//   - blob keeps the row's stored filepath as the stable key — the storage
//     strategy layer already re-signs Azure SAS from it (KK20-199)

const { buildDedupKey } = require('./dedupKey');

const DEFAULT_BATCH_SIZE = 500;

const isAzureSearchEnabled = () =>
  (process.env.AZURE_SEARCH_ENABLED || '').toLowerCase() === 'true';

/**
 * Resolve the owning agent id for an agent-library file (File rows don't
 * carry it; agents reference files via tool_resources.file_search.file_ids).
 * @param {import('mongoose')} mongoose
 * @param {string} fileId
 * @returns {Promise<string | null>}
 */
async function findOwningAgentId(mongoose, fileId) {
  const Agent = mongoose.models.Agent;
  if (!Agent) {
    return null;
  }
  const agent = await Agent.findOne({ 'tool_resources.file_search.file_ids': fileId }, { id: 1 })
    .lean()
    .exec();
  return agent?.id ?? null;
}

/**
 * Migrate one batch of legacy File rows into KnaufFileAsset records.
 *
 * @param {Object} params
 * @param {import('mongoose')} params.mongoose
 * @param {number} [params.batchSize]
 * @param {string} [params.resumeAfterId] - `_id` of the last row of the previous batch
 * @param {boolean} [params.dryRun]
 * @param {string} [params.legacyProfile] - named profile stamped on migrated assets
 * @returns {Promise<{
 *   scanned: number,
 *   assetsCreated: number,
 *   skippedExisting: number,
 *   legacyReady: number,
 *   incomplete: number,
 *   pointersBackfilled: number,
 *   agentScopeFallbacks: number,
 *   lastId: string | null,
 *   done: boolean,
 * }>}
 */
async function migrateFileAssetsBatch({
  mongoose,
  batchSize = DEFAULT_BATCH_SIZE,
  resumeAfterId,
  dryRun = false,
  legacyProfile = process.env.KNAUF_INDEX_PROFILE || 'legacy-v0',
}) {
  const File = mongoose.models.File;
  const KnaufFileAsset = mongoose.models.KnaufFileAsset;

  const query = { $or: [{ embedded: true }, { knauf_asset_id: { $exists: true } }] };
  if (resumeAfterId) {
    query._id = { $gt: resumeAfterId };
  }

  const rows = await File.find(query).sort({ _id: 1 }).limit(batchSize).lean().exec();

  const counts = {
    scanned: rows.length,
    assetsCreated: 0,
    skippedExisting: 0,
    legacyReady: 0,
    incomplete: 0,
    pointersBackfilled: 0,
    agentScopeFallbacks: 0,
    lastId: rows.length ? String(rows[rows.length - 1]._id) : null,
    done: rows.length < batchSize,
  };

  for (const row of rows) {
    const assetId = row.knauf_asset_id ?? row.file_id;
    const isAgent = row.context === 'agents';
    const isReady = row.embedded === true;

    let scopeType = 'user';
    let scopeId = row.user != null ? String(row.user) : '';
    if (isAgent) {
      const agentId = await findOwningAgentId(mongoose, row.file_id);
      if (agentId) {
        scopeType = 'agent';
        scopeId = agentId;
      } else {
        // Detached agent file — keep the owning user as scope, count it for
        // operator review rather than silently inventing an agent scope.
        counts.agentScopeFallbacks += 1;
      }
    }

    const isDedupChat = !isAgent && row.knauf_content_hash != null;

    const assetDoc = {
      asset_id: assetId,
      scope_type: scopeType,
      scope_id: scopeId,
      content_hash: row.knauf_content_hash,
      ...(isDedupChat
        ? {
            dedup_key: buildDedupKey({
              user: String(row.user),
              contentHash: row.knauf_content_hash,
            }),
          }
        : {}),
      target_index_profile: legacyProfile,
      active_index_profile: isReady ? legacyProfile : null,
      vector_backend: isAgent && isAzureSearchEnabled() ? 'azure_search' : 'pgvector',
      embed_route: isAgent ? '/agent/embed' : '/embed',
      blob: {
        source: row.source,
        path: row.filepath,
        bytes: row.bytes,
        mime: row.type,
      },
      status: isReady ? 'ready' : 'failed',
      active_generation: isReady ? 0 : null,
      target_generation: 0,
      ...(isReady
        ? { ready_at: row.updatedAt ?? row.createdAt }
        : { last_error_code: 'migration_inconsistent' }),
      queued_at: row.createdAt,
      delete_requested_at: null,
    };

    if (isReady) {
      counts.legacyReady += 1;
    } else {
      counts.incomplete += 1;
    }

    if (!dryRun) {
      const result = await KnaufFileAsset.updateOne(
        { asset_id: assetId },
        { $setOnInsert: assetDoc },
        { upsert: true },
      );
      if (result.upsertedCount === 1) {
        counts.assetsCreated += 1;
      } else {
        counts.skippedExisting += 1;
      }

      if (row.knauf_asset_id == null) {
        await File.updateOne({ _id: row._id }, { $set: { knauf_asset_id: row.file_id } });
        counts.pointersBackfilled += 1;
      }
    }
  }

  return counts;
}

module.exports = { migrateFileAssetsBatch, DEFAULT_BATCH_SIZE };
// End [knauf]
