// [knauf] KK20-194 — HTTP fetch + redirect handling for the open_url tool.
//
// SSRF protection is delegated to upstream's TOCTOU-safe
// createSSRFSafeUndiciConnect (packages/api/src/auth/agent.ts) — the same
// helper that protects MCP HTTP/SSE/streamable-HTTP transports. The upstream
// isPrivateIP is tightened for non-canonical IPv6 by a paired [knauf] seam
// in packages/api/src/auth/domain.ts.
//
// Pure orchestration: scheme/HTTPS gating, SSRF pre-check, undici dispatcher
// build, manual-redirect loop with per-hop SSRF re-check and body-drain,
// streaming body cap, content-type sniffing, paging. HTML extraction +
// untrusted-content envelope live in @knauf/knauf/server/htmlExtract.

'use strict';

const { Agent, fetch: undiciFetch } = require('undici');
const {
  createSSRFSafeUndiciConnect,
  resolveHostnameSSRF,
} = require('@librechat/api');

const { extractAndWrap } = require('@knauf/knauf/server/htmlExtract');

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

async function readBodyWithCap(response, maxBytes) {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
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

function looksLikeHtml(text) {
  const head = text.slice(0, 1024).toLowerCase();
  return head.includes('<!doctype html') || /<html\b/.test(head) || /<head\b/.test(head);
}

// R2b (KK20-194 review): anti-bot / JS-challenge interstitials return HTTP 200
// with an HTML body that has no real content — left unflagged the model would
// "summarise" the challenge page (or confabulate). Detect the common providers'
// markers on the raw HTML so the tool can report `blocked_or_js_required`
// instead of handing an empty shell to the LLM.
const CHALLENGE_MARKERS = [
  'cf-browser-verification',
  '__cf_chl',
  'cf_chl_opt',
  'just a moment',
  'checking your browser',
  'enable javascript and cookies',
  'datadome',
  'px-captcha',
];

function looksLikeChallenge(text) {
  const head = text.slice(0, 4096).toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => head.includes(marker));
}

/**
 * Validate scheme + (if needed) SSRF for a URL string. Throws FetchError on
 * any rejection. Used both for the initial URL and each redirect target.
 */
async function assertUrlAllowed(rawUrl, { allowHttp }) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new FetchError('invalid URL', 'invalid_url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FetchError('unsupported scheme', 'unsupported_scheme');
  }
  if (parsed.protocol === 'http:' && !allowHttp) {
    throw new FetchError('http:// URLs are not allowed (https only)', 'http_not_allowed');
  }
  if (await resolveHostnameSSRF(parsed.hostname)) {
    throw new FetchError('URL blocked by SSRF policy', 'ssrf_blocked');
  }
  return parsed;
}

async function fetchAndExtract(rawUrl, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.overrides || {}) };
  const maxLength = opts.maxLength ?? cfg.maxLength;
  const startIndex = Math.max(0, Number(opts.startIndex) || 0);
  const fetchImpl = opts.fetchImpl || undiciFetch;

  await assertUrlAllowed(rawUrl, cfg);

  // Connecting through this Agent means undici's DNS lookup IS our SSRF
  // check (one lookup, no TOCTOU). resolveHostnameSSRF above is the fast
  // path that avoids opening a socket for obviously-bad URLs.
  const dispatcher = opts.dispatcher || new Agent({
    connect: createSSRFSafeUndiciConnect(),
    bodyTimeout: cfg.timeoutMs,
    headersTimeout: cfg.timeoutMs,
  });
  const ownedDispatcher = !opts.dispatcher;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  let current = rawUrl;
  let redirects = 0;

  try {
    while (true) {
      const response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        dispatcher,
        headers: {
          'User-Agent': cfg.userAgent,
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        // Drain the redirect response body so undici can return the socket
        // to the pool. With redirect: 'manual' the body is never consumed
        // by the WHATWG layer, and an unconsumed body keeps the socket
        // pinned per hop.
        try { await response.body?.cancel(); } catch { /* noop */ }
        if (!location) {
          throw new FetchError('Redirect with no Location header', 'bad_redirect');
        }
        redirects += 1;
        if (redirects > cfg.maxRedirects) {
          throw new FetchError(`Too many redirects (> ${cfg.maxRedirects})`, 'too_many_redirects');
        }
        const next = new URL(location, current);
        await assertUrlAllowed(next.toString(), cfg);
        current = next.toString();
        continue;
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const finalUrl = response.url || current;

      if (!response.ok) {
        throw new FetchError(`Upstream returned HTTP ${response.status}`, `http_${response.status}`);
      }

      const declaredHtml =
        contentType.includes('text/html') || contentType.includes('application/xhtml');
      const declaredText =
        contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml');
      const declaredOctet =
        contentType === '' ||
        contentType.includes('application/octet-stream') ||
        contentType.includes('binary/');

      const { text, truncated: bodyTruncated } = await readBodyWithCap(response, cfg.maxBytes);

      const isHtml = declaredHtml || (declaredOctet && looksLikeHtml(text));
      const isText = declaredText || isHtml;

      if (isHtml && looksLikeChallenge(text)) {
        throw new FetchError(
          'the page returned an anti-bot/JS challenge instead of content',
          'blocked_or_js_required',
        );
      }

      if (!isHtml && !isText) {
        return extractAndWrap({
          kind: 'non-text',
          rawUrl,
          finalUrl,
          status: response.status,
          contentType,
          truncated: false,
        });
      }

      return extractAndWrap({
        kind: isHtml ? 'html' : 'text',
        rawUrl,
        finalUrl,
        status: response.status,
        contentType,
        body: text,
        bodyTruncated,
        maxLength,
        startIndex,
      });
    }
  } finally {
    clearTimeout(timer);
    if (ownedDispatcher) {
      try { dispatcher.close && dispatcher.close(); } catch { /* noop */ }
    }
  }
}

module.exports = {
  fetchAndExtract,
  assertUrlAllowed,
  readBodyWithCap,
  looksLikeHtml,
  looksLikeChallenge,
  FetchError,
  DEFAULTS,
};
// End [knauf]
