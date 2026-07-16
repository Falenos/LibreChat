// [knauf] KK20-195 WP4a — HTTP client for the generation-safe RAG contract
// (hardened plan §7.2/§7.6). PROVISIONAL: coded to the plan's documented
// contract before WP1 lands in agentic-karl-rag-api; the worker stays behind
// KNAUF_INDEXING_WORKER_ENABLED until the deployed rag_api implements it, so
// nothing calls this in production yet. Tests drive the claim loop against
// the in-memory fake — this module exists so the entry point wires a real
// shape, and so WP1 has one place to reconcile field names.
//
// §7.2 write request: asset_id, generation (positive int from the claim),
// blob materialization (multipart stream), persisted scope (never inferred
// from a request), index_profile. execution_token is correlation only.
// §7.6 delete: one inactive generation by asset_id + generation; idempotent.

const axios = require('axios');
const FormData = require('form-data');
const { generateShortLivedToken } = require('@librechat/api');

/** @returns {number} finite request cap (§7.5) — same knob as the sync path */
const embedTimeoutMs = () => {
  const parsed = Number.parseInt(process.env.RAG_EMBED_SYNC_TIMEOUT_MS ?? '', 10);
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
   * @param {{ source?: string, path?: string, mime?: string }} params.blob
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
    form.append('file', stream, { filename: asset_id, contentType: blob?.mime });
    const response = await axios.post(`${baseUrl()}${embed_route}`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${jwtToken}` },
      timeout: embedTimeoutMs(),
      maxBodyLength: Infinity,
    });
    // §7.5: HTTP 200 with a body-level failure is a failure, never a success.
    if (response.data?.status === false || response.data?.known_type === false) {
      const bodyError = new Error(`RAG reported failure for ${asset_id}:${generation}`);
      bodyError.status = 422;
      throw bodyError;
    }
    return response.data;
  }

  /**
   * §7.6 — delete one (inactive) generation; idempotent on the RAG side.
   * @param {{ asset_id: string, generation: number }} params
   */
  async function deleteGeneration({ asset_id, generation }) {
    await axios.delete(`${baseUrl()}/generation`, {
      data: { asset_id, generation },
      timeout: Number.parseInt(process.env.RAG_DELETE_TIMEOUT_MS ?? '', 10) || 60 * 1000,
    });
  }

  return { embedGeneration, deleteGeneration };
}

module.exports = { createGenerationRagClient };
// End [knauf]
