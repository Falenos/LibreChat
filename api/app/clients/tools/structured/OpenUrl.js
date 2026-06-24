'use strict';

// [knauf] KK20-194 — native open_url tool. Wraps @knauf/knauf/server/openUrl
// (server-side fetch + Mozilla Readability + AGK-aware SSRF deny-list) so the
// agent can read a user-pasted URL without an external SaaS scraper. Static
// HTML / text only; PDF/Office and JS-heavy pages are explicitly out of scope
// for v1 (see docs/kk20-194-open-url-tool-proposal.md).
// Entire file is Knauf-authored; tracked in SEAMS.md Net-New Files.
const { Tool } = require('@langchain/core/tools');

const { fetchAndExtract, FetchError } = require('@knauf/knauf/server/openUrl');

const openUrlJsonSchema = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      minLength: 1,
      description:
        'The exact http(s) URL to open and read. Use this whenever the user pastes a link or asks you to read a specific page.',
    },
    max_length: {
      type: 'integer',
      minimum: 500,
      maximum: 200000,
      description:
        'Maximum characters of page content to return. Defaults to ~100k. Use a smaller value for quick scans.',
    },
    start_index: {
      type: 'integer',
      minimum: 0,
      description:
        'Character offset to start returning content from. Use to page through long pages across multiple calls.',
    },
  },
  required: ['url'],
};

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
    this.description =
      'Open a specific http(s) URL and return its main readable text. Use this when the user pastes a link or asks you to read a page. Returns the article content with title; PDF / Office / other binary URLs return a short notice instead. Data never leaves the Knauf Azure tenant.';
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
      // Coarse error taxonomy. We deliberately do NOT echo back resolved IPs,
      // upstream error strings, or stack traces — those would leak internal
      // network details (e.g. `ECONNREFUSED 10.160.7.4:5432`) to the LLM
      // context, which is itself a side-channel for internal mapping.
      if (err instanceof FetchError) {
        return JSON.stringify({ error: err.message, code: err.code, url });
      }
      if (err && err.name === 'AbortError') {
        return JSON.stringify({ error: 'open_url: request timed out', code: 'timeout', url });
      }
      return JSON.stringify({
        error: 'open_url: unexpected error fetching URL',
        code: 'internal_error',
        url,
      });
    }
  }
}

module.exports = OpenUrl;
// End [knauf]
