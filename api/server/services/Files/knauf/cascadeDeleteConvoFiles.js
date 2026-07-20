// [knauf] KK20-203 — cascade file + embedding cleanup on chat deletion.
//
// Upstream `deleteConvos` removes the conversation + its messages only; the
// files those chats referenced (blobs, Mongo File rows, and pgvector
// embeddings) are orphaned forever. This Tier-3 module collects the files a
// conversation referenced and runs the existing `processDeleteRequest` over the
// ones that nothing else still references — reuse, don't reinvent the deletion.
//
// Reference-count guard (`partitionByRefCount`) is the seam KK20-204 (per-user
// content-hash dedup) plugs into: it counts surviving conversations, messages
// (which protects files shared via fork/duplicate), AND any agent still holding
// the file in tool_resources.*.file_ids (so deleting the chat a file was uploaded
// in never strips it out from under an agent); once dedup makes one physical
// blob/vector set shared across chats, the same seam gains a content-hash
// dimension so cascade never deletes a still-shared asset.
//
// Boundary (documented in knauf/docs/implementation-plans/file-lifecycle-dedup-cleanup.md):
// collection is scoped to chat-context uploads (File.conversationId — stamped on
// chat file_search uploads in process.js — plus message attachments and
// Conversation.files[]). Library-agent files configured in the agent builder
// carry no chat conversationId, so they are never collected here; agent-resource
// references are cleaned by processDeleteRequest's removeAgentResourceFilesFromAllAgents.

const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { TOOL_RESOURCE_KEYS, collectToolResourceFileIds } = require('@librechat/api');
const db = require('~/models');
// processDeleteRequest + deleteVectorsByIds are required lazily inside
// cascadeDeleteCollectedFiles (only when there's actually something to delete):
// requiring process.js at module top pulls in the image/storage-strategy chain,
// which would load on every convos.js import and break route-level unit tests
// that don't mock it (e.g. convos.spec.js).

/**
 * Resolve the conversationIds a (user, filter) pair matches — mirrors what
 * `deleteConvos` resolves internally, so the cascade cleans exactly the chats
 * that were deleted.
 * @param {{ user: string, filter: Record<string, unknown> }} params
 * @returns {Promise<string[]>}
 */
async function resolveConversationIds({ user, filter }) {
  const Conversation = mongoose.models.Conversation;
  return Conversation.find({ ...filter, user }).distinct('conversationId');
}

/**
 * Extract a file_id from a Message.files[] element (schema type is Mixed, so the
 * element is normally `{ file_id, ... }` but defensively handle a bare string).
 */
function fileIdOf(entry) {
  if (!entry) {
    return null;
  }
  return typeof entry === 'string' ? entry : entry.file_id;
}

/**
 * Add to the `acc` Set every resolvable file id in `entries`, optionally filtered
 * to the `only` Set. Entries may be bare strings or `{ file_id }` objects
 * (fileIdOf normalizes both), so one scan serves File ids, Conversation.files[],
 * Message.files[] and agent tool_resources file_ids[].
 */
function collectFileIds(acc, entries, only) {
  for (const entry of entries ?? []) {
    const id = fileIdOf(entry);
    if (id && (!only || only.has(id))) {
      acc.add(id);
    }
  }
}

/**
 * Collect the candidate File docs a set of conversations referenced, via the
 * union of the three linkages — no single one is complete:
 *   1. File.conversationId      — set on chat file_search uploads + execute_code outputs.
 *   2. Conversation.files[]     — file_id strings on the convo doc.
 *   3. Message.files[]          — message attachments carry NO conversationId, so this is
 *                                 the only link for them.
 * MUST run BEFORE the conversation + messages are deleted (links 2 and 3 vanish
 * with them; the File rows themselves survive, which is the bug we're fixing).
 * @param {{ user: string, conversationIds: string[] }} params
 * @returns {Promise<import('mongoose').Document[]>} deduped File docs
 */
async function collectConvoFileDocs({ user, conversationIds }) {
  if (!conversationIds?.length) {
    return [];
  }
  const File = mongoose.models.File;
  const Conversation = mongoose.models.Conversation;
  const Message = mongoose.models.Message;
  const fileIds = new Set();

  // 1. File.conversationId
  const directIds = await File.find({ user, conversationId: { $in: conversationIds } }).distinct(
    'file_id',
  );
  collectFileIds(fileIds, directIds);

  // 2. Conversation.files[]
  const convos = await Conversation.find(
    { conversationId: { $in: conversationIds }, user },
    'files',
  ).lean();
  for (const convo of convos) {
    collectFileIds(fileIds, convo.files);
  }

  // 3. Message.files[]
  const messages = await Message.find(
    { conversationId: { $in: conversationIds }, user, files: { $exists: true, $ne: null } },
    'files',
  ).lean();
  for (const message of messages) {
    collectFileIds(fileIds, message.files);
  }

  if (!fileIds.size) {
    return [];
  }
  // Resolve to full File docs (default projection excludes `text`, which the
  // deletion path doesn't need). Some collected ids may have no File row (e.g.
  // a stale reference) — getFiles simply omits them.
  return (await db.getFiles({ user, file_id: { $in: [...fileIds] } })) ?? [];
}

/**
 * Partition candidate files into those safe to physically delete vs those still
 * referenced outside the set of conversations being deleted. Reference counts
 * are COMPUTED (reverse-lookups), never a stored counter — a hand-maintained
 * counter drifts on retries/crashes.
 *
 * KK20-203 counts surviving conversations + messages (covers fork/duplicate
 * sharing today). KK20-204 will extend this with a content-hash dimension so a
 * deduped blob/vector set survives until its last logical reference is gone.
 *
 * @param {Array<{ file_id: string }>} files
 * @param {{ user: string, deletedConversationIds: string[] }} ctx
 * @returns {Promise<{ deletable: object[], sharedStillReferenced: object[] }>}
 */
async function partitionByRefCount(files, { user, deletedConversationIds }) {
  if (!files?.length) {
    return { deletable: [], sharedStillReferenced: [] };
  }
  const Conversation = mongoose.models.Conversation;
  const Message = mongoose.models.Message;
  const candidateIds = new Set(files.map((file) => file.file_id));
  const ids = [...candidateIds];
  const stillReferenced = new Set();

  // A surviving conversation references the file via Conversation.files[].
  const convoRefs = await Conversation.find(
    { user, files: { $in: ids }, conversationId: { $nin: deletedConversationIds } },
    'files',
  ).lean();
  for (const convo of convoRefs) {
    collectFileIds(stillReferenced, convo.files, candidateIds);
  }

  // A surviving message (outside the deleted convos) references the file.
  // Message.files[] is Mixed: entries are normally `{ file_id, ... }` but legacy/
  // imported messages can store bare-string ids (fileIdOf handles both). Match
  // BOTH shapes — `files.file_id` for object entries, `files: { $in }` for string
  // entries — or a still-referenced legacy file slips through and gets deleted.
  const msgRefs = await Message.find(
    {
      user,
      conversationId: { $nin: deletedConversationIds },
      $or: [{ 'files.file_id': { $in: ids } }, { files: { $in: ids } }],
    },
    'files',
  ).lean();
  for (const message of msgRefs) {
    collectFileIds(stillReferenced, message.files, candidateIds);
  }

  // An agent still references the file via tool_resources.<resource>.file_ids —
  // e.g. a file uploaded to an agent inside a chat lives on both the File row
  // (with conversationId) AND the agent. Deleting that chat would otherwise mark
  // it deletable, and processDeleteRequest destroys the blob/vectors AND strips
  // the id from every agent (removeAgentResourceFilesFromAllAgents) — silently
  // wiping an agent's knowledge file. Not scoped to author: any agent that holds
  // the asset still needs it. tool_resources is Mixed, so filter DB-side over the
  // canonical file-bearing resource keys, then extract via the same canonical
  // helper. We scan `.file_ids` (the PERSISTED reference that deletion strips),
  // NOT the runtime-only `.files[]` array that primeResources hydrates.
  const Agent = mongoose.models.Agent;
  const resourceFileIdPaths = TOOL_RESOURCE_KEYS.map((resource) => ({
    [`tool_resources.${resource}.file_ids`]: { $in: ids },
  }));
  const agentRefs = await Agent.find({ $or: resourceFileIdPaths }, 'tool_resources').lean();
  for (const agent of agentRefs) {
    collectFileIds(stillReferenced, collectToolResourceFileIds(agent.tool_resources), candidateIds);
  }

  const deletable = [];
  const sharedStillReferenced = [];
  for (const file of files) {
    (stillReferenced.has(file.file_id) ? sharedStillReferenced : deletable).push(file);
  }
  return { deletable, sharedStillReferenced };
}

/**
 * Collect the files a (user, filter) deletion will orphan. Call BEFORE
 * `deleteConvos`. Best-effort: a failure here must not block the convo delete,
 * so it logs and returns an empty collection.
 * @param {{ req: import('express').Request, filter: Record<string, unknown> }} params
 * @returns {Promise<{ conversationIds: string[], files: object[] }>}
 */
async function collectConvoFilesForCleanup({ req, filter }) {
  try {
    const user = req.user.id;
    const conversationIds = await resolveConversationIds({ user, filter });
    if (!conversationIds.length) {
      return { conversationIds: [], files: [] };
    }
    const files = await collectConvoFileDocs({ user, conversationIds });
    return { conversationIds, files };
  } catch (error) {
    logger.error('[knauf][cascadeDeleteConvoFiles] failed collecting files for cleanup', error);
    return { conversationIds: [], files: [] };
  }
}

/**
 * [knauf] KK20-204 — physically delete one shared asset (its pgvector embeddings +
 * its blob), keyed on the stable `knauf_asset_id`. Best-effort + idempotent: the
 * vector delete is 404-tolerant and the blob strategy tolerates a missing file, so a
 * benign double-GC under concurrent deletes can't corrupt. `embedded:false` on the
 * strategy call keeps it blob-only (vectors are handled here explicitly, keyed on
 * the asset id).
 *
 * [knauf] KK20-203 — Deduped rows are always chat file_search attachments
 * (agent-library files are never deduped), so vectors always live in pgvector
 * regardless of the Azure Search flag.
 * KK20-195 WP3d — reports success: `true` only when every attempted cleanup
 * step succeeded, so the FileAsset lifecycle wrapper can decide between
 * `removeAsset` and `delete_failed` (plan §8.3).
 * @param {{ req: import('express').Request, assetId: string, asset: { filepath?: string, source?: string, embedded?: boolean }, ledgerAsset?: Object, userId: string, deleteVectorsByIds: Function, getStrategyFunctions: Function }} params
 * @returns {Promise<boolean>}
 */
async function gcCanonicalAsset({
  req,
  assetId,
  asset,
  ledgerAsset,
  userId,
  deleteVectorsByIds,
  getStrategyFunctions,
}) {
  if (ledgerAsset) {
    const { createGenerationRagClient } = require('./generationRagClient');
    const { cleanupFileAssetPhysical } = require('./fileAssetDelete');
    return cleanupFileAssetPhysical({
      req,
      asset: ledgerAsset,
      userId,
      ragClient: createGenerationRagClient({ getStrategyFunctions }),
      getStrategyFunctions,
      logger,
    });
  }

  // Pre-FileAsset rows retain the legacy file-id based cleanup path.
  let cleaned = true;
  if (asset.embedded) {
    // [knauf] Deduped assets are always chat attachments → always pgvector
    try {
      await deleteVectorsByIds(req, [assetId]);
    } catch (error) {
      cleaned = false;
      logger.warn(
        `[knauf][cascadeDeleteConvoFiles] vector GC failed for ${assetId}; may remain in pgvector`,
        error,
      );
    }
    // End [knauf]
  }
  if (!asset.filepath) {
    logger.warn(`[knauf][cascadeDeleteConvoFiles] no filepath for ${assetId}; skipping blob GC`);
    return false;
  }
  try {
    const { deleteFile } = getStrategyFunctions(asset.source ?? 'local');
    await deleteFile(req, {
      file_id: assetId,
      filepath: asset.filepath,
      source: asset.source,
      embedded: false,
    });
  } catch (error) {
    cleaned = false;
    logger.warn(
      `[knauf][cascadeDeleteConvoFiles] blob GC failed for ${assetId} (asset may leak)`,
      error,
    );
  }
  return cleaned;
}

/**
 * [knauf] KK20-204 — two-stage delete for content-hash-deduped rows. Under dedup one
 * physical asset (blob + embeddings, both keyed on the stable `knauf_asset_id`) is
 * shared across DIFFERENT logical file_ids (the embed owner + N reuse rows), so the
 * per-file_id refcount can't decide physical deletion. Instead:
 *
 *   Stage 1 — delete the File ROWS (always; keyed on the deleted ids).
 *   Stage 2 — GC each distinct physical asset only when NO surviving row points at
 *             that specific `knauf_asset_id` (a per-asset reference count, not
 *             (user, content-hash)-group emptiness), targeting the `knauf_asset_id`
 *             for vectors and the shared filepath for the blob.
 *
 * Recounting AFTER the row delete makes "two concurrent deletes both skip → orphan"
 * impossible; the residual double-GC is benign (404-tolerant vectors + missing-file-
 * tolerant blob delete). Counting per-asset rather than per-group also avoids leaking
 * the old asset when a concurrent re-upload between stage 1 and the recount MISSes and
 * embeds a NEW asset under the same hash (its row would make the group look non-empty),
 * and reclaims a rare double-embed's duplicate asset as soon as ITS last reference is
 * gone instead of waiting for the whole hash group to empty. Every deduped row carries
 * the asset's filepath/source/embedded (copied at upload), so the asset is GC'able even
 * if the embed-owner row is already gone. Handles a rare double-embed (≥1 distinct asset
 * id per group) by GC-ing each distinct asset.
 *
 * @param {{ req: import('express').Request, dedupRows: object[] }} params
 */
async function gcDedupRows({ req, dedupRows }) {
  if (!dedupRows.length) {
    return;
  }

  // Build the groups from the in-memory rows BEFORE deleting. The recount that decides
  // physical GC is scoped to the asset OWNER (content is deduped per-user and embeddings
  // are user-owned, so the survivors of an asset are the OWNER's remaining rows, NOT the
  // deleter's). (The direct-delete route can hand us another user's file via a shared
  // agent — keying on req.user.id would recount the wrong user, find zero survivors, and
  // destroy the owner's still-shared asset. The chat cascade only ever collects
  // req.user.id's own files, so this is a no-op there.) Within a group, key distinct
  // assets by knauf_asset_id so a rare double-embed's two assets are both captured and
  // each is recounted independently; any single row yields its asset (filepath/source/
  // embedded copied at upload).
  const groups = new Map();
  for (const f of dedupRows) {
    const ownerId = String(f.user);
    const groupKey = `${ownerId}\0${f.knauf_content_hash}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { user: f.user, hash: f.knauf_content_hash, assets: new Map() };
      groups.set(groupKey, group);
    }
    const assetId = f.knauf_asset_id ?? f.file_id;
    const prev = group.assets.get(assetId);
    group.assets.set(assetId, {
      filepath: prev?.filepath ?? f.filepath,
      source: prev?.source ?? f.source,
      embedded: (prev?.embedded ?? false) || !!f.embedded,
    });
  }

  // Stage 1 — delete the logical rows (ids only; never pass a user arg — deleteFiles
  // would then ignore the ids and delete every file the user owns).
  const dedupIds = dedupRows.map((f) => f.file_id);
  await db.deleteFiles(dedupIds);
  try {
    await db.removeAgentResourceFilesFromAllAgents({ file_ids: dedupIds });
  } catch (error) {
    logger.error('[knauf][cascadeDeleteConvoFiles] agent-ref strip failed', error);
  }

  // Stage 2 — GC each distinct asset that NO surviving row still points at (recount
  // AFTER stage 1, scoped to the asset OWNER so a cross-user delete can't nuke a
  // still-referenced asset).
  // [knauf] KK20-203 — Deduped rows are always chat attachments, so GC
  // always deletes from pgvector (never Azure Search).
  const { deleteVectorsByIds } = require('~/server/services/Files/VectorDB/crud');
  const { getStrategyFunctions } = require('~/server/services/Files/strategies');
  // End [knauf]
  for (const { user, hash, assets } of groups.values()) {
    for (const [assetId, asset] of assets) {
      // Per-ASSET reference count, not (user, hash)-group emptiness: GC this physical
      // asset only when no surviving row points at THIS asset id. Group emptiness
      // would (a) leak the old asset when a concurrent re-upload between stage 1 and
      // here MISSes and embeds a NEW asset under the same hash (its row makes the group
      // look non-empty), and (b) under-collect a double-embed's duplicate while another
      // asset in the same group survives. (user, hash) hits the partial index; the
      // asset_id is filtered in memory over the small per-group set.
      const survivors =
        (await db.getFiles({ user, knauf_content_hash: hash, knauf_asset_id: assetId }, null, {
          file_id: 1,
        })) ?? [];
      if (survivors.length) {
        continue; // this asset still referenced elsewhere → keep it
      }
      // KK20-195 WP3d — record the physical GC on the FileAsset ledger (plan
      // §8.2/§8.3): tombstone BEFORE cleanup (blocks worker claims/activation
      // mid-delete), removeAsset only on confirmed cleanup, delete_failed
      // otherwise (retryable, reconciler-visible). Legacy assets without a
      // ledger row just run the cleanup as before.
      const { gcAssetThroughLifecycle } = require('./fileAssetDelete');
      await gcAssetThroughLifecycle({
        db,
        asset_id: assetId,
        logger,
        cleanup: (ledgerAsset) =>
          gcCanonicalAsset({
            req,
            assetId,
            asset,
            ledgerAsset,
            userId: String(user),
            deleteVectorsByIds,
            getStrategyFunctions,
          }),
      });
    }
  }
}

/**
 * Delete legacy / non-deduped rows the PR1 way: processDeleteRequest (blob + vectors +
 * Mongo row + agent-ref strip), then a best-effort retried vector backstop for the
 * embedded ones (the storage strategy's vector delete swallows transient failures).
 * @param {{ req: import('express').Request, plainRows: object[] }} params
 */
async function deletePlainRows({ req, plainRows }) {
  if (!plainRows.length) {
    return;
  }
  // Lazy require (see top-of-file note) — only load the deletion chain when needed.
  const { processDeleteRequest } = require('~/server/services/Files/process');
  await processDeleteRequest({ req, files: plainRows });

  // [knauf] Vector backstop: route agent files to Azure AI Search, rest to pgvector.
  const embeddedFiles = plainRows.filter((file) => file.embedded);
  if (!embeddedFiles.length) {
    return;
  }
  const { deleteVectorsForFiles } = require('~/server/services/Files/VectorDB/crud');
  try {
    await deleteVectorsForFiles(req, embeddedFiles);
  } catch (vectorError) {
    logger.warn(
      `[knauf][cascadeDeleteConvoFiles] vector backstop failed for ${embeddedFiles.length} file(s); ` +
        'embeddings may remain in pgvector or Azure AI Search',
      vectorError,
    );
  }
  // End [knauf]
}

/**
 * Cascade-delete the collected files (blob + pgvector + Mongo row + agent-resource
 * refs), skipping any still referenced outside the deleted conversations. Call AFTER
 * `deleteConvos`. Legacy/no-hash rows go through the upstream `processDeleteRequest`
 * (`deletePlainRows`); content-hash-deduped rows go through the two-stage `gcDedupRows`.
 *
 * Best-effort: never throws into the convo-delete response path. The collected
 * File docs are passed by value, so it works after the convos/messages are gone.
 *
 * @param {{ req: import('express').Request, collected: { conversationIds: string[], files: object[] } }} params
 * @returns {Promise<{ deleted: number, kept: number }>}
 */
async function cascadeDeleteCollectedFiles({ req, collected }) {
  const { conversationIds = [], files = [] } = collected ?? {};
  if (!files.length) {
    return { deleted: 0, kept: 0 };
  }
  try {
    const { deletable, sharedStillReferenced } = await partitionByRefCount(files, {
      user: req.user.id,
      deletedConversationIds: conversationIds,
    });

    if (deletable.length) {
      // req.config (appConfig) is needed by processDeleteRequest AND by the strategy
      // blob delete inside the dedup GC. The convos delete routes don't run
      // configMiddleware, so populate it here when absent rather than coupling the
      // routes to that middleware.
      if (!req.config) {
        const { getAppConfig } = require('~/server/services/Config');
        req.config = await getAppConfig({
          role: req.user?.role,
          userId: req.user?.id,
          tenantId: req.user?.tenantId,
        });
      }

      // [knauf] KK20-204 — content-hash-deduped rows share one physical asset across
      // file_ids, so they need group-aware two-stage deletion (gcDedupRows). Legacy /
      // no-hash rows keep the PR1 path (deletePlainRows → processDeleteRequest).
      await deletePlainRows({
        req,
        plainRows: deletable.filter((file) => !file.knauf_content_hash),
      });
      await gcDedupRows({
        req,
        dedupRows: deletable.filter((file) => file.knauf_content_hash),
      });
      // End [knauf]
    }

    if (sharedStillReferenced.length) {
      logger.debug(
        `[knauf][cascadeDeleteConvoFiles] kept ${sharedStillReferenced.length} file(s) still referenced by other conversations`,
      );
    }
    logger.info(
      `[knauf][cascadeDeleteConvoFiles] chat delete cleanup: removed ${deletable.length}, kept ${sharedStillReferenced.length}`,
    );
    return { deleted: deletable.length, kept: sharedStillReferenced.length };
  } catch (error) {
    logger.error('[knauf][cascadeDeleteConvoFiles] cascade cleanup failed', error);
    return { deleted: 0, kept: 0 };
  }
}

/**
 * Drop-in wrapper for `db.deleteConvos` that cascade-cleans the deleted chats'
 * files. Collects file refs BEFORE the delete (links vanish with the messages),
 * runs the upstream delete, then best-effort cleans the now-orphaned blobs /
 * vectors / Mongo rows. Returns whatever `db.deleteConvos` returns so the route
 * responds unchanged. If `db.deleteConvos` throws, it propagates and no cleanup
 * runs (nothing was deleted).
 * @param {{ req: import('express').Request, filter: Record<string, unknown> }} params
 */
async function deleteConvosWithCleanup({ req, filter }) {
  const collected = await collectConvoFilesForCleanup({ req, filter });
  const dbResponse = await db.deleteConvos(req.user.id, filter);
  await cascadeDeleteCollectedFiles({ req, collected });
  return dbResponse;
}

/**
 * [knauf] KK20-204 — dedup-aware physical delete for an EXPLICIT set of files (the
 * direct `DELETE /api/files` route), mirroring the chat-delete cascade's delete
 * stage. Without this, removing a file that owns a content-hash-deduped blob /
 * embedding set destroys the shared asset out from under other chats still
 * pointing at it (the upstream `processDeleteRequest` is not group-aware).
 *
 * Content-hash-deduped rows go through the two-stage `gcDedupRows` (delete rows,
 * then GC the shared asset only once its `(user, hash)` group is empty); legacy /
 * no-hash rows keep the upstream `processDeleteRequest` path via `deletePlainRows`.
 * `req.config` is ensured here (mirrors `cascadeDeleteCollectedFiles`) so the
 * helper is self-sufficient even though the files route's middleware sets it.
 *
 * @param {{ req: import('express').Request, files: object[] }} params - `files`
 *   MUST be full File DB docs (carrying `knauf_content_hash` / `filepath` /
 *   `source` / `embedded`), NOT client `BatchFile`s: a deduped pointer routed as
 *   "plain" would re-introduce the shared-asset deletion bug this closes.
 * @returns {Promise<void>}
 */
async function deleteFilesWithDedupAwareness({ req, files }) {
  if (!files?.length) {
    return;
  }
  if (!req.config) {
    const { getAppConfig } = require('~/server/services/Config');
    req.config = await getAppConfig({
      role: req.user?.role,
      userId: req.user?.id,
      tenantId: req.user?.tenantId,
    });
  }
  await deletePlainRows({ req, plainRows: files.filter((file) => !file.knauf_content_hash) });
  await gcDedupRows({ req, dedupRows: files.filter((file) => file.knauf_content_hash) });
}

module.exports = {
  deleteConvosWithCleanup,
  // [knauf] KK20-204 — dedup-aware direct file delete (used by the files route).
  deleteFilesWithDedupAwareness,
  // exported for unit tests + KK20-204 extension:
  collectConvoFilesForCleanup,
  cascadeDeleteCollectedFiles,
  partitionByRefCount,
  collectConvoFileDocs,
  resolveConversationIds,
};
