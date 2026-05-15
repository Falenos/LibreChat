// @ts-check
//
// walk.js — file-system traversal for `--all` mode
//
// Walks the upstream-code roots plus root-level Dockerfiles, returning
// repo-relative source-file paths. Skips conventional build outputs.

'use strict';

const fs = require('fs');
const path = require('path');
const CONFIG = require('../seams.config.js');
const { isSourceFile } = require('./classify.js');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo']);

function makeWalker(repoRoot) {
  function walkDir(dir, out) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walkDir(full, out);
      else if (ent.isFile()) out.push(full);
    }
  }

  function walkAll() {
    const roots = ['api', 'client', 'packages'];
    const files = [];
    for (const root of roots) {
      const abs = path.join(repoRoot, root);
      if (!fs.existsSync(abs)) continue;
      walkDir(abs, files);
    }
    // Root-level Dockerfiles are upstream-class and may carry inline edits.
    for (const ent of fs.readdirSync(repoRoot, { withFileTypes: true })) {
      if (ent.isFile() && CONFIG.dockerfileRe.test(ent.name)) {
        files.push(path.join(repoRoot, ent.name));
      }
    }
    return files
      .map((abs) => path.relative(repoRoot, abs).replace(/\\/g, '/'))
      .filter((rel) => isSourceFile(rel));
  }

  return { walkAll };
}

module.exports = { makeWalker };
