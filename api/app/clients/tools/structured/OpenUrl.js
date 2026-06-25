// [knauf] KK20-194 — native open_url LangChain Tool. Thin glue layer:
// validates input, delegates to ./openUrl/fetcher, maps errors to a coarse
// JSON taxonomy that never leaks resolved internal IPs into the LLM context.
// See docs/kk20-194-open-url-tool-proposal.md.

'use strict';

const { Tool } = require('@langchain/core/tools');
const { getToolDefinition } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');

const { fetchAndExtract, FetchError } = require('./openUrl/fetcher');

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

/**
 * R1 + Residual A (KK20-194 review) — Phase-1 observability only, no blocking.
 *
 * The model fully controls the `url` argument, so a prompt-injected page could
 * coax it into fetching an attacker host (exfil via path) or appending a secret
 * to a legitimate, user-pasted host's query string. We can't safely *block*
 * yet (false positives would break normal "open this link" usage), but we can
 * make both anomalies visible: compare the fetched URL against the set of URLs
 * the user actually pasted in THIS message.
 *
 * Limitation (deferred to the Phase-2 follow-up ticket): only the current
 * message's text is in scope, so a URL pasted several turns earlier reads as
 * "not user-provided". That is acceptable for a log-only signal.
 *
 * @param {string[]} userProvidedUrls  URLs extracted from the current user message
 * @returns {{ hosts: Set<string>, queryKeysByHost: Map<string, Set<string>> }}
 */
function indexUserProvidedUrls(userProvidedUrls) {
  const hosts = new Set();
  const queryKeysByHost = new Map();
  for (const raw of userProvidedUrls || []) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    hosts.add(parsed.host);
    if (!queryKeysByHost.has(parsed.host)) {
      queryKeysByHost.set(parsed.host, new Set());
    }
    for (const key of parsed.searchParams.keys()) {
      queryKeysByHost.get(parsed.host).add(key);
    }
  }
  return { hosts, queryKeysByHost };
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
    // R1 (KK20-194): request-scoped provenance inputs, injected by the
    // customConstructor in handleTools.js. Absent in unit/standalone use, in
    // which case provenance logging is simply skipped.
    this.userProvidedUrls = Array.isArray(fields.userProvidedUrls) ? fields.userProvidedUrls : [];
  }

  /**
   * Log-only host-provenance + query-anomaly checks (R1 + Residual A). Never
   * throws and never blocks — purely emits structured warnings for APM.
   */
  logProvenance(requestedUrl, host) {
    if (this.userProvidedUrls.length === 0) {
      return;
    }
    let parsed;
    try {
      parsed = new URL(requestedUrl);
    } catch {
      return;
    }
    const { hosts, queryKeysByHost } = indexUserProvidedUrls(this.userProvidedUrls);
    if (!hosts.has(parsed.host)) {
      logger.warn(
        `[open_url] url_not_user_provided host=${host} — fetched host was not in the user's pasted URLs`,
      );
      return;
    }
    const allowedKeys = queryKeysByHost.get(parsed.host) || new Set();
    const novelKeys = [...parsed.searchParams.keys()].filter((k) => !allowedKeys.has(k));
    if (novelKeys.length > 0) {
      logger.warn(
        `[open_url] query_param_not_user_provided host=${host} keys=${novelKeys.join(',')} ` +
          '— fetched URL carried query params absent from the pasted URL(s)',
      );
    }
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
    this.logProvenance(url, host);

    try {
      const result = await fetchAndExtract(url, {
        maxLength: max_length,
        startIndex: start_index,
      });
      const durationMs = Date.now() - startedAt;
      const contentChars = typeof result.content === 'string' ? result.content.length : 0;
      const meta =
        `host=${host} status=${result.status} chars=${contentChars} ` +
        `outcome=${result.outcome} truncated=${!!result.truncated} durationMs=${durationMs}`;

      // R2a (KK20-194 review): a fetch that succeeds at the HTTP layer but
      // yields no readable text (after the structured-data fallback in
      // htmlExtract) must NOT be handed to the model as an empty envelope — it
      // would invite confabulation. Surface it as an explicit error code,
      // mirroring the anti-bot challenge case detected in the fetcher (R2b).
      if (result.outcome === 'low') {
        logger.warn(`[open_url] no readable content — likely JS-only/blocked page. ${meta}`);
        return JSON.stringify({
          error:
            'open_url: the page returned no readable content (likely JavaScript-only or bot-blocked)',
          code: 'blocked_or_js_required',
          url,
        });
      }
      if (result.outcome === 'too_large') {
        logger.warn(`[open_url] page too large to parse. ${meta}`);
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
