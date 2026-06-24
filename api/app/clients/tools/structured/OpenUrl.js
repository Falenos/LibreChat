// [knauf] KK20-194 — native open_url LangChain Tool. Thin glue layer:
// validates input, delegates to ./openUrl/fetcher, maps errors to a coarse
// JSON taxonomy that never leaks resolved internal IPs into the LLM context.
// See docs/kk20-194-open-url-tool-proposal.md.

'use strict';

const { Tool } = require('@langchain/core/tools');
const { getToolDefinition } = require('@librechat/api');

const { fetchAndExtract, FetchError } = require('./openUrl/fetcher');

// Single source of truth for the schema + description lives in the registry
// (packages/api/src/tools/registry/definitions.ts). Pull it here so the
// model-facing definition, the picker, and this instance can never drift.
const { schema: openUrlJsonSchema, description: openUrlDescription } =
  getToolDefinition('open_url');

class OpenUrl extends Tool {
  static lc_name() {
    return 'open_url';
  }

  static get jsonSchema() {
    return openUrlJsonSchema;
  }

  constructor(fields = {}) {
    super(fields);
    this.name = 'open_url';
    this.description = openUrlDescription;
    this.schema = openUrlJsonSchema;
  }

  async _call(input) {
    const args = typeof input === 'string' ? { url: input } : (input || {});
    const { url, max_length, start_index } = args;
    if (!url || typeof url !== 'string') {
      return JSON.stringify({ error: 'open_url: missing required "url" string argument' });
    }

    try {
      const result = await fetchAndExtract(url, {
        maxLength: max_length,
        startIndex: start_index,
      });
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify(serialiseError(err, url));
    }
  }
}

/**
 * Map any thrown error to a coarse { error, code, url } JSON payload.
 * We deliberately do NOT echo back resolved IPs, upstream error strings, or
 * stack traces — those would leak internal network details (e.g.
 * `ECONNREFUSED 10.160.7.4:5432`) to the LLM context, which is itself a
 * side-channel for internal network mapping.
 */
function serialiseError(err, url) {
  if (err instanceof FetchError) {
    return { error: err.message, code: err.code, url };
  }
  if (err && err.name === 'AbortError') {
    return { error: 'open_url: request timed out', code: 'timeout', url };
  }
  // SSRF lookup errors from upstream's createSSRFSafeUndiciConnect surface
  // as fetch failures with `cause.code === 'ESSRF'`.
  if (err && err.cause && err.cause.code === 'ESSRF') {
    return { error: 'URL blocked by SSRF policy', code: 'ssrf_blocked', url };
  }
  return { error: 'open_url: unexpected error fetching URL', code: 'internal_error', url };
}

module.exports = OpenUrl;
// End [knauf]
