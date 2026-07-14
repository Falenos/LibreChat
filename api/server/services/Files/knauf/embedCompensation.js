// [knauf] KK20-195 WP0 — blob compensation for a failed synchronous embed.
//
// In the dual-storage file_search path the permanent blob is uploaded BEFORE
// the RAG embed, but the File row is only created after it — so when the
// embed fails (or the WP0 end-to-end deadline aborts it), nothing references
// the blob and nothing ever cleans it: the long-standing "orphan blob"
// failure mode, made more frequent by the deadline. This wrapper deletes the
// blob this request just uploaded, best-effort, then rethrows the original
// embed error. Vector compensation lives in uploadVectors itself
// (VectorDB/crud.js).
//
// Only use on paths where THIS request uploaded the blob (chat dedup-MISS and
// agent-library) — never on a dedup HIT, which reuses a shared asset.

const { logger } = require('@librechat/data-schemas');

/**
 * Run an embed and, on failure, best-effort delete the blob uploaded earlier
 * in this same request before rethrowing the original error.
 *
 * @param {Object} params
 * @param {() => Promise<Object>} params.embed - thunk performing the uploadVectors call
 * @param {ServerRequest} params.req
 * @param {string} params.file_id
 * @param {string} params.source - storage source key (e.g. FileSources.azure)
 * @param {{ filepath?: string }} [params.storageResult] - result of the blob upload
 * @param {(source: string) => { deleteFile?: Function }} params.getStrategyFunctions
 * @returns {Promise<Object>} the embed result
 */
async function embedWithBlobCompensation({
  embed,
  req,
  file_id,
  source,
  storageResult,
  getStrategyFunctions,
}) {
  try {
    return await embed();
  } catch (error) {
    try {
      const { deleteFile } = getStrategyFunctions(source);
      if (deleteFile && storageResult?.filepath) {
        await deleteFile(req, { file_id, filepath: storageResult.filepath, source });
        logger.info(
          `[embedWithBlobCompensation] deleted orphaned blob for ${file_id} after embed failure`,
        );
      }
    } catch (cleanupError) {
      logger.warn(
        `[embedWithBlobCompensation] blob cleanup failed for ${file_id}: ${cleanupError?.message}`,
      );
    }
    throw error;
  }
}

module.exports = { embedWithBlobCompensation };
