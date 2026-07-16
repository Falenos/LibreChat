/**
 * Pure HTML-to-text extraction for the open_url tool (KK20-194).
 *
 * Isolated in @knauf/knauf because the deps (jsdom, @mozilla/readability,
 * html-to-text) are heavy and Knauf-specific — keeping them out of the
 * upstream lockfiles. No SSRF / network logic lives here; that all sits in
 * the LangChain tool wrapper at api/app/clients/tools/structured/OpenUrl.js
 * and delegates to upstream's createSSRFSafeUndiciConnect.
 */

'use strict';

const { Readability } = require('@mozilla/readability');
const { JSDOM, VirtualConsole } = require('jsdom');
const { convert: htmlToText } = require('html-to-text');

// Fetched pages are untrusted input; do not forward their console or CSS parser noise.
const quietVirtualConsole = new VirtualConsole();

// R3 (KK20-194 review): jsdom + Readability build a full DOM synchronously and
// cannot be interrupted by the fetch AbortController — a multi-megabyte body
// would pin the event loop. Cap the bytes we are willing to DOM-parse; larger
// bodies skip the parse and fall back to the cheap regex structured-data
// extractor (still O(n), no DOM) or a "too large" notice.
const MAX_PARSE_BYTES = 2 * 1024 * 1024;

// Below this many characters of extracted text we treat the primary
// (Readability / html-to-text) result as a near-miss and try the structured
// fallback to enrich it. This only *triggers* the fallback — it is NOT a
// blocking threshold.
const LOW_YIELD_CHARS = 200;
// Only an essentially-empty extraction (after the fallback) is classified as
// 'low' / blocked. Kept tiny on purpose: a short-but-real page (a brief note, a
// few sentences) is genuine content the model can summarise truthfully, so it
// must stay 'ok'. The blocking path is reserved for empty JS shells.
const MIN_USABLE_CHARS = 10;

const TOO_LARGE_NOTICE =
  '[page too large to parse]\n' +
  'This page exceeded the safe parsing size limit, so its body was not ' +
  'extracted. Try a more specific sub-page if you need its content.';

/**
 * Wrap fetched content in a delimited envelope so downstream LLM prompts are
 * less likely to obey instructions injected into the page body. The tool
 * description (in OpenUrl.js) tells the model to treat the envelope contents
 * as data, not instructions.
 */
function wrapAsUntrusted(content, finalUrl) {
  // Defensive scrub: mangle any inner occurrence of the delimiter so the
  // envelope cannot be terminated early.
  const sanitised = content.replace(/<\/?UNTRUSTED_WEB_CONTENT[^>]*>/gi, (m) =>
    m.replace(/[<>]/g, ''),
  );
  return (
    `<UNTRUSTED_WEB_CONTENT url=${JSON.stringify(finalUrl)}>\n` +
    sanitised +
    `\n</UNTRUSTED_WEB_CONTENT>`
  );
}

/**
 * Primary extraction: Readability first, html-to-text as fallback. Builds a
 * DOM, so only ever called on bodies under MAX_PARSE_BYTES.
 */
function parseReadable(html, finalUrl) {
  let dom;
  try {
    dom = new JSDOM(html, { url: finalUrl, virtualConsole: quietVirtualConsole });
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
    /* fall through */
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

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#039;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(value) {
  return value.replace(/&(?:amp|lt|gt|quot|#0?39|apos|nbsp);/g, (m) => HTML_ENTITIES[m] || m);
}

/**
 * Read a single <meta> content value by attribute (e.g. property="og:description"
 * or name="description"), tolerant of attribute order. Regex-only — no DOM.
 */
function metaContent(html, attr, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ordered = new RegExp(
    `<meta\\b[^>]*\\b${attr}=["']${escaped}["'][^>]*\\bcontent=["']([^"']*)["']`,
    'i',
  );
  const reversed = new RegExp(
    `<meta\\b[^>]*\\bcontent=["']([^"']*)["'][^>]*\\b${attr}=["']${escaped}["']`,
    'i',
  );
  const m = html.match(ordered) || html.match(reversed);
  return m ? decodeEntities(m[1]).trim() : null;
}

/**
 * Pull human-readable strings out of any application/ld+json blocks. JSON-LD is
 * already in the initial HTML of most marketing/CMS pages (Product, Article,
 * etc.), so this recovers real content from pages whose body Readability cannot
 * segment. Navigation-only types (BreadcrumbList, WebSite) carry no useful prose
 * and are skipped.
 */
function extractJsonLd(html) {
  const blocks = html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  const out = [];
  for (const block of blocks) {
    let data;
    try {
      data = JSON.parse(block[1].trim());
    } catch {
      continue;
    }
    let nodes = [data];
    if (Array.isArray(data)) {
      nodes = data;
    } else if (Array.isArray(data && data['@graph'])) {
      nodes = data['@graph'];
    }
    for (const node of nodes) {
      if (!node || typeof node !== 'object') {
        continue;
      }
      const type = String(node['@type'] || '');
      if (/breadcrumblist|website|webpage|listitem|sitenavigation/i.test(type)) {
        continue;
      }
      const parts = [];
      for (const key of ['name', 'headline', 'description', 'articleBody']) {
        if (typeof node[key] === 'string' && node[key].trim()) {
          parts.push(node[key].trim());
        }
      }
      if (parts.length) {
        out.push(parts.join('\n'));
      }
    }
  }
  const joined = out.join('\n\n').trim();
  return joined || null;
}

/**
 * Cheap, DOM-free recovery path: JSON-LD prose + OpenGraph/meta description +
 * <title>. Used when the primary extractor comes up thin or the body is too
 * large to DOM-parse. Returns null when nothing usable is found.
 */
function extractStructuredData(html) {
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title =
    metaContent(html, 'property', 'og:title') ||
    (titleTag ? decodeEntities(titleTag[1]).trim() : null) ||
    null;

  const parts = [];
  const jsonLd = extractJsonLd(html);
  if (jsonLd) {
    parts.push(jsonLd);
  }
  const ogDesc = metaContent(html, 'property', 'og:description');
  if (ogDesc) {
    parts.push(ogDesc);
  }
  const metaDesc = metaContent(html, 'name', 'description');
  if (metaDesc && metaDesc !== ogDesc) {
    parts.push(metaDesc);
  }

  const content = parts.join('\n\n').trim();
  if (!content) {
    return null;
  }
  return { title, content };
}

/**
 * Resolve HTML to { title, content, outcome }. `outcome` is the semantic signal
 * the tool wrapper acts on:
 *   - 'ok'        usable text was extracted (primary or structured fallback)
 *   - 'low'       parsed fine but no readable content (likely JS-only / blocked)
 *   - 'too_large' body exceeded MAX_PARSE_BYTES and no structured data was found
 */
function extractHtml(html, finalUrl) {
  const tooLargeToParse = Buffer.byteLength(html, 'utf8') > MAX_PARSE_BYTES;

  let best = tooLargeToParse ? null : parseReadable(html, finalUrl);

  if (!best || !best.content || best.content.trim().length < LOW_YIELD_CHARS) {
    const structured = extractStructuredData(html);
    if (
      structured &&
      structured.content &&
      (!best || !best.content || structured.content.length > best.content.length)
    ) {
      best = { title: (best && best.title) || structured.title, content: structured.content };
    }
  }

  if (best && best.content && best.content.trim().length >= MIN_USABLE_CHARS) {
    return { title: best.title || null, content: best.content, outcome: 'ok' };
  }
  if (tooLargeToParse) {
    return { title: null, content: TOO_LARGE_NOTICE, outcome: 'too_large' };
  }
  return {
    title: (best && best.title) || null,
    content: (best && best.content) || '',
    outcome: 'low',
  };
}

/**
 * Single entry point for the tool wrapper. Handles HTML, plain-text, and
 * non-text (binary) bodies — returns the same { url, finalUrl, status,
 * contentType, title, content, truncated } shape in all cases, with
 * `content` always wrapped in the UNTRUSTED_WEB_CONTENT envelope.
 *
 * @param {object} input
 * @param {'html'|'text'|'non-text'} input.kind
 * @param {string} input.rawUrl
 * @param {string} input.finalUrl
 * @param {number} input.status
 * @param {string} input.contentType
 * @param {string} [input.body]  required for kind=html/text
 * @param {boolean} [input.bodyTruncated]
 * @param {number} [input.maxLength]
 * @param {number} [input.startIndex]
 * @param {boolean} [input.truncated]  for kind=non-text
 */
function extractAndWrap(input) {
  if (input.kind === 'non-text') {
    return {
      url: input.rawUrl,
      finalUrl: input.finalUrl,
      status: input.status,
      contentType: input.contentType,
      title: null,
      content: wrapAsUntrusted(
        `[non-text content: ${input.contentType || 'unknown'}]\n` +
          'This URL points to a binary/document file. For PDF/Office documents, ' +
          'consider attaching the file to chat for Document Intelligence parsing.',
        input.finalUrl,
      ),
      truncated: !!input.truncated,
      outcome: 'ok',
    };
  }

  let title = null;
  let content;
  // 'ok' for plain text; HTML extraction overrides with its own classification.
  let outcome = 'ok';
  if (input.kind === 'html') {
    const extracted = extractHtml(input.body, input.finalUrl);
    title = extracted.title;
    content = extracted.content;
    outcome = extracted.outcome;
  } else {
    content = input.body;
  }

  const startIndex = Math.max(0, Number(input.startIndex) || 0);
  let sliced = content;
  let contentTruncated = !!input.bodyTruncated;
  // The too-large notice is a fixed, self-contained message — never page it.
  if (outcome !== 'too_large') {
    if (startIndex > 0) sliced = sliced.slice(startIndex);
    if (input.maxLength != null && sliced.length > input.maxLength) {
      sliced = sliced.slice(0, input.maxLength);
      contentTruncated = true;
    }
  }

  return {
    url: input.rawUrl,
    finalUrl: input.finalUrl,
    status: input.status,
    contentType: input.contentType,
    title,
    content: wrapAsUntrusted(sliced, input.finalUrl),
    truncated: contentTruncated,
    outcome,
  };
}

module.exports = {
  extractAndWrap,
  __internal__: { extractHtml, wrapAsUntrusted, extractStructuredData, MAX_PARSE_BYTES },
};
