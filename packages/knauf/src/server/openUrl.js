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
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      return { text: text.slice(0, maxBytes), truncated: true };
    }
    return { text, truncated: false };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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
 * fetchAndExtract — see module docstring for behaviour.
 *
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {number} [opts.maxLength]
 * @param {number} [opts.startIndex]
 * @param {object} [opts.overrides] internal — override DEFAULTS in tests
 * @returns {Promise<{ url:string, finalUrl:string, status:number, contentType:string, title:string|null, content:string, truncated:boolean }>}
 */
async function fetchAndExtract(rawUrl, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.overrides || {}) };
  const maxLength = opts.maxLength ?? cfg.maxLength;
  const startIndex = Math.max(0, Number(opts.startIndex) || 0);

  let current = rawUrl;
  let redirects = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    while (true) {
      const check = await isUrlAllowed(current);
      if (!check.allowed) {
        throw new FetchError(`URL blocked by SSRF policy (${check.reason})`, 'ssrf_blocked');
      }
      const parsed = new URL(current);
      if (parsed.protocol === 'http:' && !cfg.allowHttp) {
        throw new FetchError('http:// URLs are not allowed (https only)', 'http_not_allowed');
      }

      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': cfg.userAgent,
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new FetchError(`Redirect ${response.status} with no Location header`, 'bad_redirect');
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
  __internal__: { extractHtml, readBodyWithCap },
};
