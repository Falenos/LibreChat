const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { logger } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
const { logAxiosError, generateShortLivedToken } = require('@librechat/api');

// [knauf] Azure AI Search routing — when enabled, agent files are routed to
// the /agent/* endpoints (Azure AI Search) instead of the default pgvector ones.
const useAzureSearchForAgents = () =>
  (process.env.AZURE_SEARCH_ENABLED || '').toLowerCase() === 'true';

/**
 * Deletes a file from the vector database. This function takes a file object, constructs the full path, and
 * verifies the path's validity before deleting the file. If the path is invalid, an error is thrown.
 *
 * @param {ServerRequest} req - The request object from Express.
 * @param {MongoFile} file - The file object to be deleted. It should have a `filepath` property that is
 *                           a string representing the path of the file relative to the publicPath.
 *
 * @returns {Promise<void>}
 *          A promise that resolves when the file has been successfully deleted, or throws an error if the
 *          file path is invalid or if there is an error in deletion.
 */
// [knauf] KK20-203 — bounded retry so the chat-delete cascade
// (cascadeDeleteConvoFiles) doesn't silently leak embeddings on a transient RAG
// failure. A 404 is treated as success (already gone — idempotent); 5xx / 429 /
// no-response are retried with linear backoff; other 4xx fail fast. The RAG
// `/documents` endpoint accepts an array of ids, so `deleteVectorsByIds` deletes
// a whole chat's embeddings in one call and `deleteVectors` delegates to it.
const RAG_DELETE_MAX_ATTEMPTS = 3;
const ragDeleteSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Delete embeddings for a batch of file ids from the vector database, with a
 * bounded retry on transient failures.
 * @param {ServerRequest} req
 * @param {string[]} fileIds
 * @returns {Promise<void>}
 */
// [knauf] Delete a single file's embeddings from Azure AI Search, with bounded retry.
const deleteAzureSearchVectors = async (req, fileId) => {
  const jwtToken = generateShortLivedToken(req.user.id);
  let lastError;
  for (let attempt = 1; attempt <= RAG_DELETE_MAX_ATTEMPTS; attempt++) {
    try {
      return await axios.delete(`${process.env.RAG_API_URL}/agent/documents/${fileId}`, {
        headers: {
          Authorization: `Bearer ${jwtToken}`,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
      });
    } catch (error) {
      const status = error.response?.status;
      if (status === 404) {
        return;
      }
      lastError = error;
      const isTransient = status == null || status >= 500 || status === 429;
      if (!isTransient || attempt === RAG_DELETE_MAX_ATTEMPTS) {
        break;
      }
      await ragDeleteSleep(200 * attempt);
    }
  }
  logAxiosError({ error: lastError, message: `Error deleting Azure Search vectors for ${fileId}` });
  throw new Error(lastError?.message || 'Azure AI Search delete failed.');
};
// End [knauf]

const deleteVectorsByIds = async (req, fileIds) => {
  const ids = (fileIds ?? []).filter(Boolean);
  if (!ids.length || !process.env.RAG_API_URL) {
    return;
  }
  const jwtToken = generateShortLivedToken(req.user.id);
  let lastError;
  for (let attempt = 1; attempt <= RAG_DELETE_MAX_ATTEMPTS; attempt++) {
    try {
      return await axios.delete(`${process.env.RAG_API_URL}/documents`, {
        headers: {
          Authorization: `Bearer ${jwtToken}`,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        data: ids,
      });
    } catch (error) {
      const status = error.response?.status;
      if (status === 404) {
        // Already deleted — idempotent success.
        return;
      }
      lastError = error;
      const isTransient = status == null || status >= 500 || status === 429;
      if (!isTransient || attempt === RAG_DELETE_MAX_ATTEMPTS) {
        break;
      }
      await ragDeleteSleep(200 * attempt);
    }
  }
  logAxiosError({ error: lastError, message: 'Error deleting vectors (after retries)' });
  logger.warn('Error deleting vectors, embeddings may remain');
  throw new Error(lastError?.message || 'An error occurred during file deletion.');
};

// [knauf] Batch-delete embeddings — route to Azure AI Search OR pgvector.
// When Azure Search is enabled, files are stored in Azure Search (not pgvector),
// so deletes go to Azure Search only. When disabled, normal pgvector path.
// Azure Search deletes are chunked (AZURE_SEARCH_CONCURRENCY) to avoid 429.
const AZURE_SEARCH_CONCURRENCY = 5;
const deleteVectorsForFiles = async (req, files) => {
  if (!files?.length || !process.env.RAG_API_URL) {
    return;
  }

  const ids = files.map((f) => f.file_id).filter(Boolean);
  if (!ids.length) {
    return;
  }

  // Azure Search enabled → delete from Azure Search only
  if (useAzureSearchForAgents()) {
    for (let i = 0; i < ids.length; i += AZURE_SEARCH_CONCURRENCY) {
      const chunk = ids.slice(i, i + AZURE_SEARCH_CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map((id) => deleteAzureSearchVectors(req, id)),
      );
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length) {
        logger.warn(
          `[knauf] Azure Search delete: ${failed.length}/${chunk.length} failed in chunk`,
        );
      }
    }
    return;
  }

  // Azure Search disabled → normal pgvector batch delete
  return deleteVectorsByIds(req, ids);
};
// End [knauf]

const deleteVectors = async (req, file) => {
  if (!file.embedded || !process.env.RAG_API_URL) {
    return;
  }
  // [knauf] Azure Search enabled → delete from Azure Search only;
  // disabled → normal pgvector path.
  if (useAzureSearchForAgents()) {
    return deleteAzureSearchVectors(req, file.file_id);
  }
  // End [knauf]
  return deleteVectorsByIds(req, [file.file_id]);
};
// End [knauf]

/**
 * Uploads a file to the configured Vector database
 *
 * @param {Object} params - The params object.
 * @param {Object} params.req - The request object from Express. It should have a `user` property with an `id` representing the user
 * @param {Express.Multer.File} params.file - The file object, which is part of the request. The file object should
 *                                     have a `path` property that points to the location of the uploaded file.
 * @param {string} params.file_id - The file ID.
 * @param {string} [params.entity_id] - The entity ID for shared resources.
 * @param {Object} [params.storageMetadata] - Storage metadata for dual storage pattern.
 *
 * @returns {Promise<{ filepath: string, bytes: number }>}
 *          A promise that resolves to an object containing:
 *            - filepath: The path where the file is saved.
 *            - bytes: The size of the file in bytes.
 */
async function uploadVectors({ req, file, file_id, entity_id, storageMetadata }) {
  if (!process.env.RAG_API_URL) {
    throw new Error('RAG_API_URL not defined');
  }

  try {
    const jwtToken = generateShortLivedToken(req.user.id);
    const formData = new FormData();
    formData.append('file_id', file_id);
    formData.append('file', fs.createReadStream(file.path));
    if (entity_id != null && entity_id) {
      formData.append('entity_id', entity_id);
    }

    // Include storage metadata for RAG API to store with embeddings
    if (storageMetadata) {
      formData.append('storage_metadata', JSON.stringify(storageMetadata));
    }

    const formHeaders = formData.getHeaders();

    // [knauf] Route agent file uploads to Azure AI Search endpoint when enabled
    const embedUrl = useAzureSearchForAgents() && entity_id
      ? `${process.env.RAG_API_URL}/agent/embed`
      : `${process.env.RAG_API_URL}/embed`;
    // End [knauf]

    const response = await axios.post(embedUrl, formData, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        accept: 'application/json',
        ...formHeaders,
      },
    });

    const responseData = response.data;
    logger.debug('Response from embedding file', responseData);

    if (responseData.known_type === false) {
      throw new Error(`File embedding failed. The filetype ${file.mimetype} is not supported`);
    }

    if (!responseData.status) {
      throw new Error('File embedding failed.');
    }

    return {
      bytes: file.size,
      filename: file.originalname,
      filepath: FileSources.vectordb,
      embedded: Boolean(responseData.known_type),
    };
  } catch (error) {
    logAxiosError({
      error,
      message: 'Error uploading vectors',
    });
    throw new Error(error.message || 'An error occurred during file upload.');
  }
}

module.exports = {
  deleteVectors,
  // [knauf] KK20-203 — batched, retried vector delete for the chat-delete cascade.
  deleteVectorsByIds,
  // [knauf] Azure-Search-aware batch delete for file objects — tries both Azure
  // Search and pgvector when Azure Search is enabled.
  deleteVectorsForFiles,
  // [knauf] Per-file Azure Search delete with bounded retry; also exported for
  // gcCanonicalAsset in the dedup GC path.
  deleteAzureSearchVectors,
  useAzureSearchForAgents,
  // End [knauf]
  uploadVectors,
};
