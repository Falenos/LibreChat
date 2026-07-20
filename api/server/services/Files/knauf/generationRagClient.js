// [knauf] KK20-195 WP4a — HTTP client for the generation-safe RAG contract
// (hardened plan §7.2/§7.6), implemented by agentic-karl-rag-api#16. The
// worker stays behind KNAUF_INDEXING_WORKER_ENABLED until that contract is
// deployed and its integration gate passes.
//
// §7.2 write request: asset_id, generation (positive int from the claim),
// blob materialization (multipart stream), persisted scope (never inferred
// from a request), index_profile. execution_token is correlation only.
// §7.6 delete: one inactive generation by asset_id + generation; idempotent.

const axios = require('axios');
const FormData = require('form-data');
const { generateShortLivedToken } = require('@librechat/api');

/**
 * @returns {number} finite request cap (§7.5). The worker has its OWN budget:
 * async indexing exists precisely to allow long (20-minute) OCR jobs, so it
 * must NOT inherit RAG_EMBED_SYNC_TIMEOUT_MS — that knob is the in-request
 * budget WP0 tunes DOWN to stop uploads hanging (see VectorDB/crud.js).
 */
const embedTimeoutMs = () => {
  const parsed = Number.parseInt(process.env.KNAUF_WORKER_EMBED_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60 * 1000;
};

/**
 * @param {Object} deps
 * @param {(source: string) => { getDownloadStream: Function }} deps.getStrategyFunctions
 * @returns {{ embedGeneration: Function, deleteGeneration: Function }}
 */
function createGenerationRagClient({ getStrategyFunctions }) {
  const baseUrl = () => process.env.RAG_API_URL;

  /**
   * @param {Object} params - claim projection from the worker loop
   * @param {string} params.asset_id
   * @param {number} params.generation
   * @param {string} params.index_profile
   * @param {string} params.embed_route - '/embed' | '/agent/embed'
   * @param {{ source?: string, path?: string, mime?: string, filename?: string }} params.blob
   * @param {{ userId: string, entityId: string }} params.scope
   */
  async function embedGeneration({
    asset_id,
    generation,
    index_profile,
    embed_route,
    blob,
    scope,
  }) {
    const jwtToken = generateShortLivedToken(scope.userId);
    const { getDownloadStream } = getStrategyFunctions(blob?.source ?? 'local');
    // Persisted scope only (plan §9.1): the stream request carries the
    // asset's stable path, never anything reconstructed from an Express req.
    const stream = await getDownloadStream({ user: { id: scope.userId } }, blob?.path);
    const form = new FormData();
    form.append('file_id', asset_id);
    form.append('generation', String(generation));
    form.append('index_profile', index_profile);
    form.append('entity_id', scope.entityId);
    // RAG loader selection is extension-based. Keep the sanitized original
    // name so async PDF/PPTX/DOCX uploads take the same parser/OCR path as
    // synchronous uploads; asset_id alone has no extension.
    form.append('file', stream, {
      filename: blob?.filename ?? asset_id,
      contentType: blob?.mime,
    });
    const response = await axios.post(`${baseUrl()}${embed_route}`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${jwtToken}` },
      timeout: embedTimeoutMs(),
      maxBodyLength: Infinity,
    });
    // §7.5: HTTP 200 with a body-level failure is a failure, never a success.
    const result = response.data;
    const complete =
      result?.status === 'ready' &&
      result.asset_id === asset_id &&
      result.generation === generation &&
      result.index_profile === index_profile &&
      Number.isInteger(result.chunks_expected) &&
      result.chunks_expected >= 0 &&
      result.chunks_written === result.chunks_expected;
    if (!complete) {
      const contractError = new Error(
        `RAG returned an incomplete generation for ${asset_id}:${generation}`,
      );
      contractError.status = 502;
      throw contractError;
    }
    return result;
  }

  /**
   * §7.6 — delete one (inactive) generation; idempotent on the RAG side.
   * Authenticated like every other rag_api call — the JWT is minted from the
   * asset's owning user (resolved by the caller); without it rag_api 401s and
   * cleanup churns forever in delete_failed.
   * @param {{ asset_id: string, generation: number, vector_backend?: 'pgvector'|'azure_search', userId?: string }} params
   */
  async function deleteGeneration({ asset_id, generation, vector_backend, userId }) {
    const headers = {};
    if (userId) {
      headers.Authorization = `Bearer ${generateShortLivedToken(userId)}`;
    }
    await axios.delete(`${baseUrl()}/generation`, {
      data: { asset_id, generation, ...(vector_backend ? { backend: vector_backend } : {}) },
      headers,
      timeout: Number.parseInt(process.env.RAG_DELETE_TIMEOUT_MS ?? '', 10) || 60 * 1000,
    });
  }

  return { embedGeneration, deleteGeneration };
}

module.exports = { createGenerationRagClient };
// End [knauf]
