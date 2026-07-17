const fs = require('fs');
// [knauf] KK20-195 WP0 — crypto for full-jitter retry backoff.
const crypto = require('node:crypto');
// End [knauf]
const axios = require('axios');
const FormData = require('form-data');
const { logger } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
// [knauf] KK20-195 WP0 — file-index metric recorders. Called with optional
// chaining: many test suites partially mock '@librechat/api', and this module
// sits in their require graphs — recorders must degrade to no-ops, never throw.
const {
  logAxiosError,
  generateShortLivedToken,
  recordFileIndexEmbed,
  recordFileIndexProviderError,
  recordFileIndexEmbedRetry,
} = require('@librechat/api');
// End [knauf]

// [knauf] Azure AI Search routing — when enabled, agent files are routed to
// the /agent/* endpoints (Azure AI Search) instead of the default pgvector ones.
const isAzureSearchEnabledForAgents = () =>
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

// [knauf] KK20-195 WP0 — RAG containment guardrails (accepted plan, WP0).
// The embed call had no timeout and no retry: a slow OCR/embed held the upload
// request open indefinitely, and a transient 429/5xx failed the user immediately
// (Datadog, 30 days: 314x Azure embedding 429s with Retry-After 1-57s; failed
// jobs still returned HTTP 200). This bounds the in-request (synchronous) embed
// and adds a bounded, Retry-After-aware retry. All knobs are env-tunable; final
// values come from WP0 measurement. The async worker introduced later in
// KK20-195 uses its own, longer calibrated timeout — not RAG_EMBED_SYNC_TIMEOUT_MS.
/**
 * Parse a non-negative integer env knob; falls back on absent/invalid values.
 * Local on purpose — no load-time dependency on shared-package utilities.
 * @param {string | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
const envInt = (value, fallback) => {
  const parsed = Number(value);
  return value != null && value !== '' && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : fallback;
};

const RAG_EMBED_SYNC_TIMEOUT_MS = envInt(process.env.RAG_EMBED_SYNC_TIMEOUT_MS, 300_000);
const RAG_EMBED_MAX_ATTEMPTS = Math.max(1, envInt(process.env.RAG_EMBED_MAX_ATTEMPTS, 3));
const RAG_EMBED_BACKOFF_BASE_MS = envInt(process.env.RAG_EMBED_BACKOFF_BASE_MS, 1_000);
const RAG_EMBED_BACKOFF_MAX_MS = envInt(process.env.RAG_EMBED_BACKOFF_MAX_MS, 30_000);
const RAG_EMBED_RETRY_AFTER_MAX_MS = envInt(process.env.RAG_EMBED_RETRY_AFTER_MAX_MS, 60_000);
const RAG_DELETE_TIMEOUT_MS = envInt(process.env.RAG_DELETE_TIMEOUT_MS, 60_000);

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) to milliseconds,
 * capped at RAG_EMBED_RETRY_AFTER_MAX_MS. Returns null when absent/invalid.
 * @param {string | undefined} headerValue
 * @returns {number | null}
 */
const parseRetryAfterMs = (headerValue) => {
  if (headerValue == null || headerValue === '') {
    return null;
  }
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(seconds, 0) * 1000, RAG_EMBED_RETRY_AFTER_MAX_MS);
  }
  const deltaMs = Date.parse(headerValue) - Date.now();
  if (Number.isFinite(deltaMs) && deltaMs > 0) {
    return Math.min(deltaMs, RAG_EMBED_RETRY_AFTER_MAX_MS);
  }
  return null;
};

/**
 * Retryable = ONLY a provider throttle (429) until WP1 lands. The current RAG
 * pipeline appends vectors by file_id, can skip rollback after a partial batch
 * failure, and cannot cancel in-flight work — so an ambiguous failure
 * (408/5xx/connection reset/timeout) may arrive AFTER some vectors were
 * written; replaying the same file_id would duplicate them. The fuller retry
 * classes (accepted plan §5.3) activate with WP1's generation-safe writes, on
 * the async worker path — not here. Body-level failures never retry.
 * @param {unknown} error
 * @returns {boolean}
 */
const isRetryableEmbedError = (error) => {
  if (error?.knaufNoRetry) {
    return false;
  }
  return error?.response?.status === 429;
};

/**
 * Handle a failed embed attempt: record provider metrics and, when the attempt
 * may be retried, return the pre-retry delay. Retry-After is treated as a
 * FLOOR with the full-jitter backoff added on top — taking max() instead would
 * synchronize every concurrent retry on the provider's exact value and
 * recreate the burst this work contains. Returns null when no retry is
 * allowed (non-retryable class, attempt budget spent, or the end-to-end
 * deadline cannot fit the delay plus a meaningful attempt).
 * @param {unknown} error
 * @param {number} attempt
 * @param {'embed' | 'agent_embed'} metricRoute
 * @param {number} remainingMs - time left in the end-to-end embed budget
 * @returns {number | null}
 */
const embedRetryDelayMs = (error, attempt, metricRoute, remainingMs) => {
  const status = error?.response?.status;
  if (status === 429) {
    recordFileIndexProviderError?.(metricRoute, '429');
  } else if (status >= 500) {
    recordFileIndexProviderError?.(metricRoute, '5xx');
  }
  if (!isRetryableEmbedError(error) || attempt >= RAG_EMBED_MAX_ATTEMPTS) {
    return null;
  }
  const retryAfterMs = parseRetryAfterMs(error?.response?.headers?.['retry-after']);
  const capMs = Math.min(RAG_EMBED_BACKOFF_BASE_MS * 2 ** (attempt - 1), RAG_EMBED_BACKOFF_MAX_MS);
  const jitterMs = crypto.randomInt(0, Math.max(1, Math.floor(capMs)) + 1);
  const delayMs = (retryAfterMs ?? 0) + jitterMs;
  if (delayMs >= remainingMs) {
    return null;
  }
  return delayMs;
};

/**
 * Record a failed embed attempt on the shared attempt state and decide the
 * retry delay (null = no retry). Extracted so uploadVectors stays readable.
 * @param {unknown} error
 * @param {number} attempt
 * @param {'embed' | 'agent_embed'} metricRoute
 * @param {number} deadlineAtMs
 * @param {{ outcome: string, lastError?: unknown }} attemptState
 * @returns {number | null}
 */
const handleEmbedAttemptError = (error, attempt, metricRoute, deadlineAtMs, attemptState) => {
  if (error?.code === 'ECONNABORTED') {
    attemptState.outcome = 'timeout';
  }
  attemptState.lastError = error;
  return embedRetryDelayMs(error, attempt, metricRoute, deadlineAtMs - Date.now());
};

/**
 * Best-effort vector reconciliation after a failed embed: some batches may
 * have landed before the failure, and an axios abort does NOT cancel
 * rag_api's in-flight work — so this delete is compensation, not a guarantee.
 * A write landing after it can still leave vectors; the WP4 reconciler sweeps
 * those and WP1's generation-safe writes remove the race entirely.
 * @param {ServerRequest} req
 * @param {string} file_id
 * @param {boolean} attempted - whether any embed POST was actually fired
 * @param {{ azureSearch?: boolean }} [options] - route cleanup to the store the embed targeted
 * @returns {Promise<void>}
 */
const compensateEmbedFailure = async (req, file_id, attempted, { azureSearch = false } = {}) => {
  if (!attempted) {
    return;
  }
  try {
    if (azureSearch) {
      // [knauf] KK20-195 review — the failed embed went to Azure AI Search
      // (/agent/embed); its partial vectors live there, not in pgvector, so
      // compensate against the SAME store or they orphan permanently.
      await deleteAzureSearchVectors(req, file_id);
    } else {
      await deleteVectorsByIds(req, [file_id]);
    }
  } catch (cleanupError) {
    logger.warn(
      `[uploadVectors] compensating vector delete failed for ${file_id}: ${cleanupError?.message}`,
    );
  }
};

/**
 * Build the multipart body for one embed attempt. Rebuilt per attempt — the
 * file read stream is consumed by each POST.
 * @param {{ file: Express.Multer.File, file_id: string, entity_id?: string, storageMetadata?: Object }} params
 * @returns {FormData}
 */
const buildEmbedFormData = ({ file, file_id, entity_id, storageMetadata }) => {
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
  return formData;
};

/**
 * Validate the embed response body; throws a non-retryable error on failure.
 * Body-level failures inside an HTTP 200 fail fast — the correct non-2xx
 * semantics are the rag_api slice of WP0.
 * @param {{ known_type?: boolean, status?: unknown }} responseData
 * @param {Express.Multer.File} file
 * @returns {void}
 */
const assertEmbedBodyOk = (responseData, file) => {
  if (responseData.known_type === false) {
    const unsupported = new Error(
      `File embedding failed. The filetype ${file.mimetype} is not supported`,
    );
    unsupported.knaufNoRetry = true;
    unsupported.knaufOutcome = 'unsupported_type';
    throw unsupported;
  }
  if (!responseData.status) {
    const bodyFailure = new Error('File embedding failed.');
    bodyFailure.knaufNoRetry = true;
    throw bodyFailure;
  }
};
// End [knauf]

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
        // [knauf] KK20-195 WP0 — bound the delete call (retry already exists).
        timeout: RAG_DELETE_TIMEOUT_MS,
        // End [knauf]
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
        // [knauf] KK20-195 WP0 — bound the delete call (retry already exists).
        timeout: RAG_DELETE_TIMEOUT_MS,
        // End [knauf]
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

// [knauf] Batch-delete embeddings — route agent files to Azure AI Search,
// everything else to pgvector. Only files attached to agents (context 'agents')
// are stored in Azure Search; chat/message attachments always go to pgvector.
// Azure Search deletes are chunked (AZURE_SEARCH_CONCURRENCY) to avoid 429.
const AZURE_SEARCH_CONCURRENCY = 5;
const deleteVectorsForFiles = async (req, files) => {
  if (!files?.length || !process.env.RAG_API_URL) {
    return;
  }

  const validFiles = files.filter((f) => f.file_id);
  if (!validFiles.length) {
    return;
  }

  const azureEnabled = isAzureSearchEnabledForAgents();
  const agentFiles = azureEnabled ? validFiles.filter((f) => f.context === 'agents') : [];
  const pgFiles = validFiles.filter((f) => !azureEnabled || f.context !== 'agents');

  // Non-agent files (or all files when Azure Search disabled) → pgvector
  // Runs first so a mixed batch's chat cleanup is never blocked by Azure failures.
  if (pgFiles.length) {
    await deleteVectorsByIds(
      req,
      pgFiles.map((f) => f.file_id),
    );
  }

  // Agent files → Azure AI Search (when enabled), chunked 5-at-a-time
  const azureFailedIds = [];
  if (agentFiles.length) {
    const ids = agentFiles.map((f) => f.file_id);
    for (let i = 0; i < ids.length; i += AZURE_SEARCH_CONCURRENCY) {
      const chunk = ids.slice(i, i + AZURE_SEARCH_CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map((id) => deleteAzureSearchVectors(req, id)),
      );
      results.forEach((r, idx) => {
        if (r.status === 'rejected') {
          azureFailedIds.push(chunk[idx]);
        }
      });
    }
    if (azureFailedIds.length) {
      const msg = `[knauf] Azure Search delete failed for: ${azureFailedIds.join(', ')}`;
      logger.warn(msg);
      throw new Error(msg);
    }
  }
};
// End [knauf]

const deleteVectors = async (req, file) => {
  if (!file.embedded || !process.env.RAG_API_URL) {
    return;
  }
  // [knauf] Agent files → Azure Search when enabled; everything else → pgvector.
  if (isAzureSearchEnabledForAgents() && file.context === 'agents') {
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
 * @param {boolean} [params.isAgentFile] - Whether this is an agent-library file (routes to Azure Search when enabled).
 * @param {Object} [params.storageMetadata] - Storage metadata for dual storage pattern.
 *
 * @returns {Promise<{ filepath: string, bytes: number }>}
 *          A promise that resolves to an object containing:
 *            - filepath: The path where the file is saved.
 *            - bytes: The size of the file in bytes.
 */
async function uploadVectors({ req, file, file_id, entity_id, isAgentFile, storageMetadata }) {
  if (!process.env.RAG_API_URL) {
    throw new Error('RAG_API_URL not defined');
  }

  // [knauf] Route agent-library uploads to Azure AI Search when enabled.
  // Only agent files (isAgentFile=true) go to Azure Search; chat file_search
  // attachments always go to pgvector even though they carry entity_id.
  const embedUrl =
    isAzureSearchEnabledForAgents() && isAgentFile
      ? `${process.env.RAG_API_URL}/agent/embed`
      : `${process.env.RAG_API_URL}/embed`;
  // End [knauf]

  // [knauf] KK20-195 WP0 — bounded, Retry-After-aware embed with ONE end-to-end
  // deadline (RAG_EMBED_SYNC_TIMEOUT_MS is the total budget across attempts,
  // not per attempt) and baseline metrics.
  const metricRoute = embedUrl.endsWith('/agent/embed') ? 'agent_embed' : 'embed';
  const startedAtMs = Date.now();
  const deadlineAtMs = startedAtMs + RAG_EMBED_SYNC_TIMEOUT_MS;
  const attemptState = { outcome: 'failure', lastError: undefined };
  let attempted = false;
  try {
    for (let attempt = 1; attempt <= RAG_EMBED_MAX_ATTEMPTS; attempt++) {
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      const formData = buildEmbedFormData({ file, file_id, entity_id, storageMetadata });
      // Fresh token per attempt: a slow attempt plus a Retry-After sleep can
      // outlive the token's 5-minute default and 401 the next attempt.
      const jwtToken = generateShortLivedToken(req.user.id);
      attempted = true;

      let response;
      try {
        response = await axios.post(embedUrl, formData, {
          headers: {
            Authorization: `Bearer ${jwtToken}`,
            accept: 'application/json',
            ...formData.getHeaders(),
          },
          timeout: remainingMs,
        });
      } catch (error) {
        const delayMs = handleEmbedAttemptError(
          error,
          attempt,
          metricRoute,
          deadlineAtMs,
          attemptState,
        );
        if (delayMs == null) {
          break;
        }
        recordFileIndexEmbedRetry?.(metricRoute);
        await ragDeleteSleep(delayMs);
        continue;
      }

      const responseData = response.data;
      logger.debug('Response from embedding file', responseData);
      assertEmbedBodyOk(responseData, file);

      attemptState.outcome = 'success';
      return {
        bytes: file.size,
        filename: file.originalname,
        filepath: FileSources.vectordb,
        embedded: Boolean(responseData.known_type),
      };
    }

    throw attemptState.lastError ?? new Error('Embed aborted: end-to-end budget exhausted.');
  } catch (error) {
    attemptState.outcome = error?.knaufOutcome ?? attemptState.outcome;
    await compensateEmbedFailure(req, file_id, attempted, {
      azureSearch: metricRoute === 'agent_embed',
    });
    logAxiosError({
      error,
      message: 'Error uploading vectors',
    });
    throw new Error(error.message || 'An error occurred during file upload.');
  } finally {
    recordFileIndexEmbed?.(metricRoute, attemptState.outcome, (Date.now() - startedAtMs) / 1000);
  }
  // End [knauf]
}

module.exports = {
  deleteVectors,
  // [knauf] KK20-203 — batched, retried vector delete for the chat-delete cascade.
  deleteVectorsByIds,
  // [knauf] Context-aware batch delete — agent files to Azure Search, rest to pgvector.
  deleteVectorsForFiles,
  // [knauf] Per-file Azure Search delete with bounded retry; used by
  // deleteVectorsForFiles and deleteVectors for agent-file routing.
  deleteAzureSearchVectors,
  // [knauf] Flag check; used by deleteVectorsForFiles, deleteVectors, and
  // fileSearch.js (query routing).
  isAzureSearchEnabledForAgents,
  // KK20-195 WP0 — exported for unit tests of the containment guardrails.
  parseRetryAfterMs,
  isRetryableEmbedError,
  embedRetryDelayMs,
  // End [knauf]
  uploadVectors,
};
