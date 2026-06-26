// [knauf] KK20-203 — cascade file + embedding cleanup on chat deletion.
//
// Upstream `deleteConvos` removes the conversation + its messages only; the
// files those chats referenced (blobs, Mongo File rows, and pgvector
// embeddings) are orphaned forever. This Tier-3 module collects the files a
// conversation referenced and runs the existing `processDeleteRequest` over the
// ones that nothing else still references — reuse, don't reinvent the deletion.
//
// Reference-count guard (`partitionByRefCount`) is the seam KK20-204 (per-user
// content-hash dedup) plugs into: today it counts surviving conversations +
// messages (which already protects files shared via fork/duplicate); once dedup
// makes one physical blob/vector set shared across chats, the same seam gains a
// content-hash dimension so cascade never deletes a still-shared asset.
//
// Boundary (documented in knauf/docs/implementation-plans/file-lifecycle-dedup-cleanup.md):
// collection is scoped to chat-context uploads (File.conversationId — stamped on
// chat file_search uploads in process.js — plus message attachments and
// Conversation.files[]). Library-agent files configured in the agent builder
// carry no chat conversationId, so they are never collected here; agent-resource
// references are cleaned by processDeleteRequest's removeAgentResourceFilesFromAllAgents.

const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
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
  for (const id of directIds) {
    if (id) {
      fileIds.add(id);
    }
  }

  // 2. Conversation.files[]
  const convos = await Conversation.find(
    { conversationId: { $in: conversationIds }, user },
    'files',
  ).lean();
  for (const convo of convos) {
    for (const id of convo.files ?? []) {
      if (id) {
        fileIds.add(id);
      }
    }
  }

  // 3. Message.files[]
  const messages = await Message.find(
    { conversationId: { $in: conversationIds }, user, files: { $exists: true, $ne: null } },
    'files',
  ).lean();
  for (const message of messages) {
    for (const entry of message.files ?? []) {
      const id = fileIdOf(entry);
      if (id) {
        fileIds.add(id);
      }
    }
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
    for (const id of convo.files ?? []) {
      if (candidateIds.has(id)) {
        stillReferenced.add(id);
      }
    }
  }

  // A surviving message (outside the deleted convos) references the file.
  const msgRefs = await Message.find(
    {
      user,
      'files.file_id': { $in: ids },
      conversationId: { $nin: deletedConversationIds },
    },
    'files',
  ).lean();
  for (const message of msgRefs) {
    for (const entry of message.files ?? []) {
      const id = fileIdOf(entry);
      if (id && candidateIds.has(id)) {
        stillReferenced.add(id);
      }
    }
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
 * Cascade-delete the collected files (blob + pgvector + Mongo row + agent-resource
 * refs) via the existing `processDeleteRequest`, skipping any still referenced
 * outside the deleted conversations. Call AFTER `deleteConvos`.
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
      // Lazy require (see top-of-file note) — only load the deletion chain when
      // there's actually something to delete.
      const { processDeleteRequest } = require('~/server/services/Files/process');
      // processDeleteRequest needs req.config (appConfig). The convos delete
      // routes don't run configMiddleware, so populate it here when absent
      // rather than coupling the routes to that middleware.
      if (!req.config) {
        const { getAppConfig } = require('~/server/services/Config');
        req.config = await getAppConfig({
          role: req.user?.role,
          userId: req.user?.id,
          tenantId: req.user?.tenantId,
        });
      }
      // processDeleteRequest deletes blob (per-source strategy) + vectors +
      // Mongo row + strips file_id from all agents' tool_resources.
      await processDeleteRequest({ req, files: deletable });

      // Best-effort vector backstop: the storage-strategy path deletes vectors
      // via deleteRagFile, which swallows transient failures. Re-issue a single
      // retried, 404-tolerant batched delete for the embedded ids so a transient
      // RAG hiccup doesn't silently leak embeddings.
      const embeddedIds = deletable.filter((file) => file.embedded).map((file) => file.file_id);
      if (embeddedIds.length) {
        const { deleteVectorsByIds } = require('~/server/services/Files/VectorDB/crud');
        try {
          await deleteVectorsByIds(req, embeddedIds);
        } catch (vectorError) {
          logger.warn(
            `[knauf][cascadeDeleteConvoFiles] vector backstop failed for ${embeddedIds.length} file(s); ` +
              'they may remain in pgvector',
            vectorError,
          );
        }
      }
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

module.exports = {
  deleteConvosWithCleanup,
  // exported for unit tests + KK20-204 extension:
  collectConvoFilesForCleanup,
  cascadeDeleteCollectedFiles,
  partitionByRefCount,
  collectConvoFileDocs,
  resolveConversationIds,
};
