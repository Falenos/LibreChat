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
const { JSDOM } = require('jsdom');
const { convert: htmlToText } = require('html-to-text');

/**
 * Wrap fetched content in a delimited envelope so downstream LLM prompts are
 * less likely to obey instructions injected into the page body. The tool
 * description (in OpenUrl.js) tells the model to treat the envelope contents
 * as data, not instructions.
 */
function wrapAsUntrusted(content, finalUrl) {
  // Defensive scrub: mangle any inner occurrence of the delimiter so the
  // envelope cannot be terminated early.
  const sanitised = content.replace(
    /<\/?UNTRUSTED_WEB_CONTENT[^>]*>/gi,
    (m) => m.replace(/[<>]/g, ''),
  );
  return (
    `<UNTRUSTED_WEB_CONTENT url=${JSON.stringify(finalUrl)}>\n` +
    sanitised +
    `\n</UNTRUSTED_WEB_CONTENT>`
  );
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
    };
  }

  let title = null;
  let content;
  if (input.kind === 'html') {
    const extracted = extractHtml(input.body, input.finalUrl);
    title = extracted.title;
    content = extracted.content;
  } else {
    content = input.body;
  }

  const startIndex = Math.max(0, Number(input.startIndex) || 0);
  let sliced = content;
  let contentTruncated = !!input.bodyTruncated;
  if (startIndex > 0) sliced = sliced.slice(startIndex);
  if (input.maxLength != null && sliced.length > input.maxLength) {
    sliced = sliced.slice(0, input.maxLength);
    contentTruncated = true;
  }

  return {
    url: input.rawUrl,
    finalUrl: input.finalUrl,
    status: input.status,
    contentType: input.contentType,
    title,
    content: wrapAsUntrusted(sliced, input.finalUrl),
    truncated: contentTruncated,
  };
}

module.exports = {
  extractAndWrap,
  __internal__: { extractHtml, wrapAsUntrusted },
};
