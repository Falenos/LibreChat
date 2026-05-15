// @ts-check
//
// scan.js — discover [knauf] markers in source files
//
// Marker model:
//   • Opening:  `<comment-token> [knauf] <description>`
//   • Closing:  `<comment-token> End [knauf]`
//   • Comment tokens are per-extension. A `// [knauf]` in a Dockerfile is
//     wrong syntax for the host language and is therefore NOT a marker.
//   • Pairing is stack-based; depth > 1 is a structural error and surfaces
//     as `nested-open`. Near-misses (`[Knauf]`, `[ knauf ]`, missing close
//     bracket) surface as `malformed-marker` instead of being silently
//     accepted or silently ignored.

'use strict';

const fs = require('fs');
const path = require('path');
const CONFIG = require('../seams.config.js');

// Per-extension comment tokens. A marker is only recognized when preceded by
// a comment-open token that's syntactically valid for the file's language.
const COMMENT_TOKENS = {
  js: ['//', '/*', '{/*'],
  jsx: ['//', '/*', '{/*'],
  ts: ['//', '/*', '{/*'],
  tsx: ['//', '/*', '{/*'],
  mjs: ['//', '/*'],
  cjs: ['//', '/*'],
  css: ['/*'],
  yml: ['#'],
  yaml: ['#'],
  html: ['<!--'],
  htm: ['<!--'],
  mdx: ['<!--', '{/*'],
};
const DOCKERFILE_TOKENS = ['#'];
const FALLBACK_TOKENS = ['//', '/*', '{/*', '#', '<!--'];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commentTokensFor(rel) {
  const base = path.basename(rel);
  if (CONFIG.dockerfileRe.test(base)) return DOCKERFILE_TOKENS;
  const ext = path.extname(rel).slice(1).toLowerCase();
  return COMMENT_TOKENS[ext] || FALLBACK_TOKENS;
}

// Build per-file regexes.
//   openRe       — exact `[knauf]`, optional description, anchored to EOL.
//   closeRe      — exact `End [knauf]`.
//   looksLikeRe  — anything that looks like an attempted marker (wrong case,
//                  whitespace inside brackets, missing close bracket).
//                  Checked only when openRe/closeRe didn't match.
function buildPatternsFor(rel) {
  const tokens = commentTokensFor(rel);
  const alt = tokens.map(escapeRe).join('|');
  return {
    openRe: new RegExp(`(?:${alt})\\s*\\[knauf\\](?:\\s+(.*))?$`),
    closeRe: new RegExp(`(?:${alt})\\s*End\\s+\\[knauf\\]`),
    looksLikeRe: new RegExp(`(?:${alt})\\s*\\[[^\\]]*[Kk][Nn][Aa][Uu][Ff][^\\]]*(?:\\]|$)`),
  };
}

// Strip the comment-close shell from a captured description. Only tokens that
// complete the comment syntax are removed — leading em-dashes, colons, and
// other punctuation are author content and stay.
function cleanDescription(raw) {
  if (!raw) return '';
  return raw
    .replace(/\s*-->\s*$/, '')
    .replace(/\s*\*\/\}?\s*$/, '')
    .trim();
}

function makeScanner(repoRoot) {
  function scanFile(rel) {
    const abs = path.join(repoRoot, rel);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch (_e) {
      return { seams: [], unpaired: [], missing: true };
    }
    const { openRe, closeRe, looksLikeRe } = buildPatternsFor(rel);
    const lines = content.split('\n');
    const seams = [];
    const unpaired = [];
    const stack = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Close first — otherwise `// End [knauf]` could trip "looks like".
      if (closeRe.test(line)) {
        const open = stack.pop();
        if (open) {
          seams.push({
            file: rel,
            startLine: open.line,
            endLine: i + 1,
            description: open.description,
          });
        } else {
          unpaired.push({ file: rel, line: i + 1, kind: 'close-without-open' });
        }
        continue;
      }

      const m = line.match(openRe);
      if (m) {
        if (stack.length > 0) {
          unpaired.push({
            file: rel,
            line: i + 1,
            kind: 'nested-open',
            openedAt: stack[stack.length - 1].line,
          });
        }
        stack.push({ line: i + 1, description: cleanDescription(m[1] || '') });
        continue;
      }

      if (looksLikeRe.test(line)) {
        unpaired.push({ file: rel, line: i + 1, kind: 'malformed-marker' });
      }
    }
    for (const open of stack) {
      unpaired.push({ file: rel, line: open.line, kind: 'open-without-close' });
    }
    return { seams, unpaired, missing: false };
  }

  function fileHasMarker(rel) {
    const abs = path.join(repoRoot, rel);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      return false;
    }
    return /\[knauf\]/.test(content);
  }

  return { scanFile, fileHasMarker };
}

module.exports = {
  makeScanner,
  cleanDescription,
  commentTokensFor,
  buildPatternsFor,
  COMMENT_TOKENS,
  DOCKERFILE_TOKENS,
};
