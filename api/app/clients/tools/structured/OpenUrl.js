// [knauf] KK20-194 — native open_url LangChain Tool. Thin glue layer:
// validates input, delegates to ./openUrl/fetcher, maps errors to a coarse
// JSON taxonomy that never leaks resolved internal IPs into the LLM context.
// See docs/kk20-194-open-url-tool-proposal.md.

'use strict';

const { Tool } = require('@langchain/core/tools');
const { getToolDefinition } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');

const { fetchAndExtract, FetchError } = require('./openUrl/fetcher');

// Length of the fixed UNTRUSTED_WEB_CONTENT envelope wrapper (open + close
// tags + url attribute scaffolding) is variable, so we approximate "usable
// extracted text" by the raw content length. Anything below this is almost
// certainly a JS-heavy SPA shell with no readable body — the exact case that
// tempts the model to confabulate a summary instead of reporting an empty
// fetch. We log it as a warning so it is visible in server logs / APM.
const LOW_CONTENT_CHARS = 200;

/**
 * Best-effort hostname for log tags without throwing on malformed input.
 */
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

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
      logger.warn('[open_url] invoked with missing/invalid url argument');
      return JSON.stringify({ error: 'open_url: missing required "url" string argument' });
    }

    // Authoritative proof the tool actually ran (vs. the model confabulating a
    // page summary from its own knowledge). Every real fetch emits exactly one
    // of these lines — grep `[open_url]` in server logs / APM to audit usage.
    const startedAt = Date.now();
    const host = safeHost(url);
    logger.info(`[open_url] fetch start host=${host}`);

    try {
      const result = await fetchAndExtract(url, {
        maxLength: max_length,
        startIndex: start_index,
      });
      const durationMs = Date.now() - startedAt;
      const contentChars = typeof result.content === 'string' ? result.content.length : 0;
      const meta =
        `host=${host} status=${result.status} chars=${contentChars} ` +
        `truncated=${!!result.truncated} durationMs=${durationMs}`;
      if (contentChars < LOW_CONTENT_CHARS) {
        // The fetch succeeded but yielded almost no readable text. Flag it so
        // an empty-but-"successful" open_url is distinguishable from a model
        // that never called the tool at all.
        logger.warn(`[open_url] fetch ok but low extracted content — likely JS-heavy page. ${meta}`);
      } else {
        logger.info(`[open_url] fetch ok ${meta}`);
      }
      return JSON.stringify(result);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const payload = serialiseError(err, url);
      logger.warn(`[open_url] fetch failed host=${host} code=${payload.code} durationMs=${durationMs}`);
      return JSON.stringify(payload);
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
