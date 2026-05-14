// @ts-check
//
// classify.js — decide which class a path belongs to
//
// Returns one of: 'knauf-only' | 'config' | 'meta' | 'upstream' | 'ignore'.
// Only `upstream` requires a [knauf] marker when modified — that's the rule
// `diff-check` enforces.
//
// Order matters in classifyFile: each rule is a short-circuit, so the first
// match wins. The order is documented inline.

'use strict';

const CONFIG = require('../seams.config.js');

function classifyFile(p) {
  const norm = p.replace(/\\/g, '/');

  // 1. node_modules — top-level AND nested-workspace (e.g. client/node_modules/...)
  if (norm.startsWith('node_modules/') || norm.includes('/node_modules/')) return 'ignore';
  if (CONFIG.ignorePrefixes.some((d) => norm.startsWith(d))) return 'ignore';

  // 2. Top-level knauf/ is tooling/docs, not runtime code. Not tracked as a seam.
  if (norm.startsWith('knauf/')) return 'meta';

  // 3. Knauf-owned directories under upstream paths (e.g. client/src/knauf/...)
  if (CONFIG.knaufDirs.some((d) => norm.startsWith(d))) return 'knauf-only';
  // Defensive: any path component named `knauf` (e.g. someone adds api/foo/knauf/...).
  if (/(^|\/)knauf\//.test(norm)) return 'knauf-only';

  // 4. Knauf-controlled config (full ownership; modifying these is normal).
  if (CONFIG.configFiles.has(norm)) return 'config';
  if (norm.startsWith('.env')) return 'config';

  // 5. Root-level Dockerfiles are upstream files modified inline — they
  //    require [knauf] markers. This must come BEFORE the meta checks.
  if (CONFIG.dockerfileRe.test(norm)) return 'upstream';

  // 6. Meta — tooling, CI, repo glue.
  if (CONFIG.metaPrefixes.some((d) => norm.startsWith(d))) return 'meta';
  if (CONFIG.lockfiles.has(norm)) return 'meta';
  if (!norm.includes('/') && norm.endsWith('.md')) return 'meta';
  if (CONFIG.rootMetaFiles.has(norm)) return 'meta';

  // 7. Upstream code — the class that requires a marker on modification.
  if (CONFIG.upstreamPrefixes.some((d) => norm.startsWith(d))) return 'upstream';

  // 8. Unknown top-level files default to meta — won't trigger the tag requirement.
  return 'meta';
}

function isSourceFile(f) {
  const path = require('path');
  if (CONFIG.sourceExtensions.has(path.extname(f))) return true;
  return CONFIG.dockerfileRe.test(path.basename(f));
}

module.exports = { classifyFile, isSourceFile };
