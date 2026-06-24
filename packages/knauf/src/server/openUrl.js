/**
 * Server-side URL fetch + main-content extraction (KK20-194).
 *
 * Pure (no LangChain coupling) so it is independently unit-testable.
 * The structured Tool wrapper lives in
 * api/app/clients/tools/structured/OpenUrl.js.
 *
 * Design:
 *  - HTTPS-only by default (HTTP behind explicit allowHttp flag).
 *  - AGK-aware SSRF deny-list (see ./ssrf.js) on the initial URL AND on
 *    every redirect.
 *  - DNS rebinding closed by pinning the connection to the IP that
 *    `isUrlAllowed` validated, via a per-request undici `Agent` whose
 *    `connect.lookup` returns that IP regardless of what undici would
 *    otherwise resolve.
 *  - Hard caps: timeout, max redirects, response body size.
 *  - HTML  -> Mozilla Readability article body, falling back to html-to-text.
 *  - Non-HTML -> short notice ("not HTML") + content-type (handled by caller
 *    where useful — e.g. PDF/Office can be routed to Document Intelligence
 *    in a later iteration).
 *  - Returns { url, finalUrl, status, contentType, title, content, truncated }.
 */

'use strict';

const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const { convert: htmlToText } = require('html-to-text');
const { Agent, fetch: undiciFetch } = require('undici');

const { isUrlAllowed } = require('./ssrf');

const DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  maxRedirects: 5,
  maxBytes: 5 * 1024 * 1024,
  maxLength: 100_000,
  userAgent: 'AgenticKarl-OpenUrl/1.0 (+https://agentic-karl.knauf.com)',
  allowHttp: false,
});

class FetchError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function extractHtml(html, finalUrl) {
  let dom;
  try {
    dom = new JSDOM(html, { url: finalUrl });
  } catch {
    return { title: null, content: htmlToText(html, { wordwrap: false }) };
  }
  try {
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article && article.textContent && article.textContent.trim().length > 0) {
      return { title: article.title || null, content: article.textContent.trim() };
    }
  } catch {
    /* fall through to html-to-text */
  }
  const title = dom.window.document.querySelector('title')?.textContent?.trim() || null;
  return {
    title,
    content: htmlToText(html, {
      wordwrap: false,
      selectors: [{ selector: 'a', options: { ignoreHref: true } }],
    }),
  };
}

async function readBodyWithCap(response, maxBytes) {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    // Streams API is required so the body is capped BEFORE buffering.
    throw new FetchError('upstream response body is not streamable', 'unstreamable_body');
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      truncated = true;
      const overflow = total - maxBytes;
      chunks.push(value.subarray(0, value.byteLength - overflow));
      try { await reader.cancel(); } catch { /* noop */ }
      break;
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: buf.toString('utf8'), truncated };
}

/**
 * Build an undici Agent that pins outbound connections to the given IP.
 * `host` is preserved on the URL (for Host header + SNI) — only the underlying
 * socket destination is overridden. This is what closes the DNS-rebinding
 * TOCTOU: `isUrlAllowed` resolved + validated the IP, and we now make undici
 * connect to exactly that IP without re-resolving.
 */
function pinnedAgent(address, family) {
  return new Agent({
    connect: {
      lookup: (_host, _opts, cb) => cb(null, address, family),
    },
  });
}

/**
 * fetchAndExtract — see module docstring for behaviour.
 *
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {number} [opts.maxLength]
 * @param {number} [opts.startIndex]
 * @param {object} [opts.overrides] internal — override DEFAULTS in tests
 * @param {Function} [opts.fetchImpl] internal — override fetch in tests
 * @returns {Promise<{ url:string, finalUrl:string, status:number, contentType:string, title:string|null, content:string, truncated:boolean }>}
 */
async function fetchAndExtract(rawUrl, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.overrides || {}) };
  const maxLength = opts.maxLength ?? cfg.maxLength;
  const startIndex = Math.max(0, Number(opts.startIndex) || 0);
  const fetchImpl = opts.fetchImpl || undiciFetch;

  let current = rawUrl;
  let redirects = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    while (true) {
      const check = await isUrlAllowed(current);
      if (!check.allowed) {
        throw new FetchError('URL blocked by SSRF policy', 'ssrf_blocked');
      }
      const parsed = new URL(current);
      if (parsed.protocol === 'http:' && !cfg.allowHttp) {
        throw new FetchError('http:// URLs are not allowed (https only)', 'http_not_allowed');
      }

      // Pin the connection to the IP we validated. Without this, undici would
      // re-resolve and a malicious TTL=0 record could swap the public IP for
      // a private one (DNS rebinding).
      const dispatcher = pinnedAgent(check.address, check.family);

      let response;
      try {
        response = await fetchImpl(current, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          dispatcher,
          headers: {
            'User-Agent': cfg.userAgent,
            Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          },
        });
      } finally {
        // Agent is per-request — release it ASAP. close() returns a promise;
        // we don't await it because the response stream may still own sockets.
        try { dispatcher.close && dispatcher.close(); } catch { /* noop */ }
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new FetchError('Redirect with no Location header', 'bad_redirect');
        }
        redirects += 1;
        if (redirects > cfg.maxRedirects) {
          throw new FetchError(`Too many redirects (> ${cfg.maxRedirects})`, 'too_many_redirects');
        }
        current = new URL(location, current).toString();
        continue;
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const finalUrl = response.url || current;

      if (!response.ok) {
        throw new FetchError(`Upstream returned HTTP ${response.status}`, `http_${response.status}`);
      }

      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
      const isText =
        contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml');

      if (!isHtml && !isText) {
        return {
          url: rawUrl,
          finalUrl,
          status: response.status,
          contentType,
          title: null,
          content:
            `[non-text content: ${contentType || 'unknown'}]\n` +
            'This URL points to a binary/document file. For PDF/Office documents, ' +
            'consider attaching the file to chat for Document Intelligence parsing.',
          truncated: false,
        };
      }

      const { text, truncated: bodyTruncated } = await readBodyWithCap(response, cfg.maxBytes);
      let title = null;
      let content;
      if (isHtml) {
        const extracted = extractHtml(text, finalUrl);
        title = extracted.title;
        content = extracted.content;
      } else {
        content = text;
      }

      let sliced = content;
      let contentTruncated = bodyTruncated;
      if (startIndex > 0) {
        sliced = sliced.slice(startIndex);
      }
      if (sliced.length > maxLength) {
        sliced = sliced.slice(0, maxLength);
        contentTruncated = true;
      }

      return {
        url: rawUrl,
        finalUrl,
        status: response.status,
        contentType,
        title,
        content: sliced,
        truncated: contentTruncated,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  fetchAndExtract,
  FetchError,
  DEFAULTS,
  __internal__: { extractHtml, readBodyWithCap, pinnedAgent },
};
