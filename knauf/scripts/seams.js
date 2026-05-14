#!/usr/bin/env node
/*
 * knauf/scripts/seams.js
 *
 * Authors and validates the [knauf] seam manifest in SEAMS.md.
 *
 * Subcommands:
 *   scan        list discovered seams (default scope: --diff)
 *   write       interactive update of the Inline Modifications table
 *   check       exit 1 if SEAMS.md is out of sync with discovered seams
 *   diff-check  exit 1 if any modified upstream-class file lacks a [knauf] marker
 *
 * Scope flags (scan/write/check):
 *   --diff           changed files vs `git merge-base main HEAD` (default)
 *   --all            scan the whole repo
 *   --base=<ref>     override the diff base
 *
 * Write flags:
 *   --dry-run        print the diff, never prompt, never write (exit 1 on drift)
 *   --yes            skip the approval prompt
 *
 * Exit codes:
 *   0  success / no drift
 *   1  drift detected (check, dry-run, diff-check)
 *   2  internal error (git failure, parser failure, missing files)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const readline = require('readline');
const { parseArgs: nodeParseArgs } = require('node:util');

// Minimum Node version. The script uses util.parseArgs (18.3+), node:test (18+),
// and crypto.randomBytes (always). Fail fast with a clear message instead of a
// confusing late error.
const MIN_NODE_MAJOR = 18;
{
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    console.error(
      `error: seams.js requires Node ${MIN_NODE_MAJOR}+ (you have ${process.versions.node}).`,
    );
    process.exit(2);
  }
}

// Resolve the repo root by walking up from this file until we find a .git
// directory. Falls back to the historical two-levels-up assumption so the
// script keeps working if it's ever run outside a git repo (CI tarball etc.).
function findRepoRoot(startDir) {
  let dir = startDir;
  // Limit the walk to ~10 levels to avoid runaway loops on broken filesystems.
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, '..', '..');
}

const REPO_ROOT = findRepoRoot(__dirname);
const SEAMS_PATH = path.join(REPO_ROOT, 'SEAMS.md');
const SENTINEL_BEGIN = '<!-- seams:auto:begin -->';
const SENTINEL_END = '<!-- seams:auto:end -->';
const SENTINEL_NEW_BEGIN = '<!-- seams:new:begin -->';
const SENTINEL_NEW_END = '<!-- seams:new:end -->';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.css']);
// Dockerfiles have no standard extension; match by base name.
const DOCKERFILE_RE = /^Dockerfile(\..*)?$/;

// Color output is enabled iff: stdout is a TTY, NO_COLOR is not set, and
// --no-color was not passed. FORCE_COLOR=1 overrides the TTY check (useful
// when piping through tee, less -R, or CI log viewers that handle ANSI).
// https://no-color.org / https://force-color.org
function colorsEnabled() {
  if (process.argv.includes('--no-color')) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return !!process.stdout.isTTY;
}
const USE_COLOR = colorsEnabled();
const C = {
  red: USE_COLOR ? '\x1b[31m' : '',
  green: USE_COLOR ? '\x1b[32m' : '',
  yellow: USE_COLOR ? '\x1b[33m' : '',
  cyan: USE_COLOR ? '\x1b[36m' : '',
  dim: USE_COLOR ? '\x1b[2m' : '',
  bold: USE_COLOR ? '\x1b[1m' : '',
  reset: USE_COLOR ? '\x1b[0m' : '',
};

// ---------- argv ----------

// Wraps Node's util.parseArgs. strict: false keeps the old "accept anything"
// behavior while gaining: typed values (booleans don't become "true" strings),
// proper handling of `--flag value` AND `--flag=value`, and a `--` terminator.
function parseArgv(argv) {
  const { values, positionals } = nodeParseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      diff: { type: 'boolean' },
      all: { type: 'boolean' },
      base: { type: 'string' },
      json: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
      help: { type: 'boolean' },
      'no-color': { type: 'boolean' },
    },
  });
  return { _: positionals, flags: values };
}

// ---------- file classification ----------

const KNAUF_DIRS = [
  'api/knauf/',
  'api/server/routes/knauf/',
  'client/src/knauf/',
  'packages/knauf/',
  'assets/knauf/',
];

const CONFIG_FILES = new Set(['librechat.yaml', 'docker-compose.override.yml']);

const UPSTREAM_PREFIXES = [
  'api/',
  'client/',
  'packages/api/',
  'packages/client/',
  'packages/data-provider/',
  'packages/data-schemas/',
];

const META_PREFIXES = ['.github/', '.husky/', '.vscode/', '.do/', '.devcontainer/'];
// IGNORE_PREFIXES: top-level directories whose contents are never code-of-record.
// We test prefix-match AND `/node_modules/` anywhere-substring (for nested
// workspace node_modules) in classifyFile.
const IGNORE_PREFIXES = ['dist/', 'build/', '.turbo/', '.git/'];
const LOCKFILES = new Set(['bun.lock', 'package-lock.json', 'yarn.lock']);
const ROOT_META_FILES = new Set([
  'package.json',
  'turbo.json',
  '.prettierrc',
  '.gitignore',
  '.gitattributes',
  '.nvmrc',
  '.dockerignore',
  'LICENSE',
]);

/**
 * Returns one of: 'knauf-only', 'config', 'meta', 'upstream', 'ignore'.
 * The 'upstream' class is the only one that requires a [knauf] marker when modified.
 */
function classifyFile(p) {
  const norm = p.replace(/\\/g, '/');

  // node_modules check covers both top-level (`node_modules/foo/...`) and
  // nested-workspace (`client/node_modules/foo/...`) cases.
  if (norm.startsWith('node_modules/') || norm.includes('/node_modules/')) return 'ignore';
  if (IGNORE_PREFIXES.some((d) => norm.startsWith(d))) return 'ignore';

  // Top-level knauf/ is Knauf tooling/docs — not runtime code, not tracked as a seam.
  if (norm.startsWith('knauf/')) return 'meta';

  if (KNAUF_DIRS.some((d) => norm.startsWith(d))) return 'knauf-only';
  // Defensive: any path component named `knauf` inside api/, client/, packages/, etc.
  if (/(^|\/)knauf\//.test(norm)) return 'knauf-only';

  if (CONFIG_FILES.has(norm)) return 'config';
  if (norm.startsWith('.env')) return 'config';
  // Root-level Dockerfiles are upstream files modified inline — require [knauf] markers.
  if (DOCKERFILE_RE.test(norm)) return 'upstream';

  if (META_PREFIXES.some((d) => norm.startsWith(d))) return 'meta';
  if (LOCKFILES.has(norm)) return 'meta';
  // Top-level markdown is always meta (CLAUDE.md, README.md, AGENTS.md, SEAMS.md, etc.).
  if (!norm.includes('/') && norm.endsWith('.md')) return 'meta';
  if (ROOT_META_FILES.has(norm)) return 'meta';

  if (UPSTREAM_PREFIXES.some((d) => norm.startsWith(d))) return 'upstream';

  // Unknown top-level files default to meta — won't trigger the tag requirement.
  return 'meta';
}

// ---------- git ----------

// spawnSync with argv array — bypasses the shell entirely so refs like
// `HEAD; rm -rf ~` can't be injected via `--base=<ref>`. All callers must
// pass `args` as an array, never a template string.
function git(args, opts = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError(`git() requires an args array, got ${typeof args}`);
  }
  const r = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', opts.quiet ? 'ignore' : 'pipe'],
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const stderr = (r.stderr || '').trim();
    const err = new Error(`git ${args.join(' ')} exited ${r.status}${stderr ? `: ${stderr}` : ''}`);
    err.status = r.status;
    throw err;
  }
  return r.stdout;
}

// Resolve the repo's default branch. Order:
//   1. SEAMS_BASE_REF env var (explicit override — wins everywhere)
//   2. `origin/HEAD` symbolic ref (canonical "what's the default")
//   3. First of `main`, `master` that exists locally (fork / detached clones)
//   4. Hard fallback to `main` (preserves old behavior)
function resolveDefaultBranch() {
  if (process.env.SEAMS_BASE_REF) return process.env.SEAMS_BASE_REF.trim();
  try {
    const out = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      quiet: true,
    }).trim();
    if (out) return out.replace(/^origin\//, '') || 'main';
  } catch (_e) {
    /* fall through */
  }
  for (const ref of ['main', 'master']) {
    try {
      git(['rev-parse', '--verify', '--quiet', ref], { quiet: true });
      return ref;
    } catch (_e) {
      /* try next */
    }
  }
  return 'main';
}

function resolveDiffBase(explicit) {
  if (explicit) return String(explicit).trim();
  const branch = resolveDefaultBranch();
  try {
    return git(['merge-base', branch, 'HEAD']).trim();
  } catch (e) {
    fail(`could not resolve diff base (git merge-base ${branch} HEAD failed): ${e.message}`);
  }
}

function changedFiles(base) {
  // `git diff --name-only <base>` (no `..` or `...`) means "working tree vs base",
  // which is the union of committed + staged + unstaged changes. Locally this
  // catches uncommitted edits; in CI the working tree equals HEAD, so the
  // result matches a PR-style three-dot diff against `<base>`.
  let out;
  try {
    out = git(['diff', '--name-only', '--diff-filter=ACMR', base]);
  } catch (e) {
    fail(`git diff failed against base ${base}: ${e.message}`);
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// ---------- file walk (--all mode) ----------

function walkAll() {
  const roots = ['api', 'client', 'packages'];
  const files = [];
  for (const root of roots) {
    const abs = path.join(REPO_ROOT, root);
    if (!fs.existsSync(abs)) continue;
    walkDir(abs, files);
  }
  // Root-level Dockerfiles are upstream-class and may carry inline [knauf] edits.
  for (const ent of fs.readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (ent.isFile() && DOCKERFILE_RE.test(ent.name)) {
      files.push(path.join(REPO_ROOT, ent.name));
    }
  }
  return files
    .map((abs) => path.relative(REPO_ROOT, abs).replace(/\\/g, '/'))
    .filter((rel) => isSourceFile(rel));
}

function walkDir(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return;
  }
  for (const ent of entries) {
    if (
      ent.name === 'node_modules' ||
      ent.name === 'dist' ||
      ent.name === 'build' ||
      ent.name === '.turbo'
    )
      continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkDir(full, out);
    else if (ent.isFile()) out.push(full);
  }
}

function isSourceFile(f) {
  if (SOURCE_EXTENSIONS.has(path.extname(f))) return true;
  return DOCKERFILE_RE.test(path.basename(f));
}

// ---------- marker scanning ----------

// Comment-syntax registry keyed by file extension (without the dot). A file's
// markers must use a comment style its language actually supports. This stops
// `# [knauf]` from being recognized in a .tsx file or `// [knauf]` in a
// Dockerfile — both of which would either be syntax errors or live inside a
// string literal.
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
// Fallback when extension is unknown — keep the union, matches pre-refactor behavior.
const FALLBACK_TOKENS = ['//', '/*', '{/*', '#', '<!--'];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commentTokensFor(rel) {
  const base = path.basename(rel);
  if (DOCKERFILE_RE.test(base)) return DOCKERFILE_TOKENS;
  const ext = path.extname(rel).slice(1).toLowerCase();
  return COMMENT_TOKENS[ext] || FALLBACK_TOKENS;
}

// Build per-file regexes. Three patterns:
//   openRe       — exact `[knauf]`, optional description, anchored to EOL.
//   closeRe      — exact `End [knauf]`.
//   looksLikeRe  — anything that looks like an attempted marker (wrong case,
//                  whitespace inside brackets, missing close bracket).
//                  Used only when openRe/closeRe didn't match.
function buildPatternsFor(rel) {
  const tokens = commentTokensFor(rel);
  const alt = tokens.map(escapeRe).join('|');
  return {
    openRe: new RegExp(`(?:${alt})\\s*\\[knauf\\](?:\\s+(.*))?$`),
    closeRe: new RegExp(`(?:${alt})\\s*End\\s+\\[knauf\\]`),
    looksLikeRe: new RegExp(`(?:${alt})\\s*\\[[^\\]]*[Kk][Nn][Aa][Uu][Ff][^\\]]*(?:\\]|$)`),
  };
}

function scanFile(rel) {
  const abs = path.join(REPO_ROOT, rel);
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

    // Close first — otherwise `// End [knauf]` could also satisfy "looks like".
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
        // Nested opens aren't valid in this model. Surface it so it doesn't
        // silently confuse the stack pairing. We still push so the inner close
        // pairs with this open; the outer one ends up as `open-without-close`.
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

    // Catch near-miss markers: `[Knauf]`, `[ knauf ]`, `[knauf` (no closing
    // bracket), `[knauf-foo]`. These would otherwise pass diff-check silently.
    if (looksLikeRe.test(line)) {
      unpaired.push({ file: rel, line: i + 1, kind: 'malformed-marker' });
    }
  }
  for (const open of stack) {
    unpaired.push({ file: rel, line: open.line, kind: 'open-without-close' });
  }
  return { seams, unpaired, missing: false };
}

// Strip the comment-close shell from a captured description. We only remove
// tokens that complete the comment syntax of the host language; everything
// else (including leading em-dashes, colons, and trailing punctuation) is the
// author's content and stays put.
function cleanDescription(raw) {
  if (!raw) return '';
  return raw
    .replace(/\s*-->\s*$/, '') // HTML/JSX-style close
    .replace(/\s*\*\/\}?\s*$/, '') // /* ... */ or {/* ... */}
    .trim();
}

function fileHasMarker(rel) {
  const abs = path.join(REPO_ROOT, rel);
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    return false;
  }
  return /\[knauf\]/.test(content);
}

// ---------- row aggregation ----------

/**
 * Collapse multiple seams in the same file into one row (matching the
 * existing SEAMS.md convention where comma-separated ranges share a row).
 */
function aggregateRows(seams) {
  const byFile = new Map();
  for (const s of seams) {
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file).push(s);
  }
  const rows = [];
  for (const [file, list] of byFile) {
    list.sort((a, b) => a.startLine - b.startLine);
    const ranges = list.map((s) => `${s.startLine}–${s.endLine}`).join(', ');
    // Use only the first marker's description as a starting Purpose for new rows.
    // Subsequent markers in the same file are usually continuations — letting
    // a human pick the canonical description avoids noisy concatenation.
    const purpose = (list.find((s) => s.description) || {}).description || PLACEHOLDER;
    rows.push({ file, lines: ranges, purpose });
  }
  return rows;
}

// ---------- group/sort for new rows ----------

function rowGroup(file) {
  if (/\.spec\.(jsx?|tsx?)$|\.test\.(jsx?|tsx?)$|__tests__/.test(file)) return 2;
  if (file.startsWith('api/')) return 0;
  if (file.startsWith('client/')) return 1;
  return 3;
}

function compareNewRows(a, b) {
  const ga = rowGroup(a.file);
  const gb = rowGroup(b.file);
  if (ga !== gb) return ga - gb;
  return a.file.localeCompare(b.file);
}

// ---------- SEAMS.md parsing ----------

function readSeamsMd() {
  if (!fs.existsSync(SEAMS_PATH)) {
    fail(`SEAMS.md not found at ${SEAMS_PATH}`);
  }
  return fs.readFileSync(SEAMS_PATH, 'utf8');
}

/**
 * Returns { before, autoBlock, after } where autoBlock is the text *between*
 * the sentinel comments (not including them). If sentinels are missing,
 * returns { before: full, autoBlock: null, after: '' } so callers can decide
 * whether to error or insert sentinels.
 */
function splitAutoBlock(md) {
  const ib = md.indexOf(SENTINEL_BEGIN);
  const ie = md.indexOf(SENTINEL_END);
  if (ib === -1 || ie === -1 || ie < ib) {
    return { before: md, autoBlock: null, after: '' };
  }
  const before = md.slice(0, ib + SENTINEL_BEGIN.length);
  const autoBlock = md.slice(ib + SENTINEL_BEGIN.length, ie);
  const after = md.slice(ie);
  return { before, autoBlock, after };
}

/**
 * Parse the auto-block table rows into objects keyed by file.
 * Preserves row order so unchanged rows stay where the editor put them.
 *
 * **Strict mode:** A line that starts with `|` and isn't the header or
 * separator IS an attempt at a data row. If it has the wrong column count or
 * an empty File cell, we throw — never silently skip. Silently skipping a
 * malformed hand-edit would cause `mergeRows` to treat every row as "new" and
 * destroy the human-curated columns on the next `write`.
 */
function parseAutoBlockRows(autoBlock) {
  if (!autoBlock) return [];
  const rows = [];
  const blockLines = autoBlock.split('\n');
  for (let i = 0; i < blockLines.length; i++) {
    const raw = blockLines[i];
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    if (/^\|\s*-+\s*\|/.test(line)) continue; // markdown header separator
    if (/^\|\s*File\s*\|/.test(line)) continue; // header row
    const cells = splitTableCells(line);
    if (cells.length !== 5) {
      throw new Error(
        `SEAMS.md Inline Modifications: row at block line ${i + 1} has ${cells.length} cell(s), expected 5. Row: "${line}"`,
      );
    }
    const file = stripBackticks(cells[0]);
    if (!file) {
      throw new Error(
        `SEAMS.md Inline Modifications: row at block line ${i + 1} has empty File cell. Row: "${line}"`,
      );
    }
    rows.push({
      file,
      symbol: cells[1],
      lines: cells[2],
      purpose: cells[3],
      tests: cells[4],
    });
  }
  return rows;
}

function splitTableCells(line) {
  const inner = line.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim());
}

function stripBackticks(s) {
  return s.replace(/^`/, '').replace(/`$/, '').trim();
}

// ---------- merge: existing rows + discovered seams ----------

const PLACEHOLDER = '—';

function mergeRows(existing, discovered) {
  const discoveredByFile = new Map(discovered.map((r) => [r.file, r]));
  const existingByFile = new Map(existing.map((r) => [r.file, r]));

  // Pass 1: walk existing rows in order. Keep rows whose file still has markers
  // and update *only* the Lines column. Symbol/Anchor, Purpose, and Tests are
  // human-curated and never overwritten on a row that already exists. Drop
  // rows whose file lost its markers.
  const merged = [];
  for (const row of existing) {
    const d = discoveredByFile.get(row.file);
    if (!d) continue;
    merged.push({
      file: row.file,
      symbol: row.symbol || PLACEHOLDER,
      lines: d.lines,
      purpose: row.purpose || PLACEHOLDER,
      tests: row.tests || PLACEHOLDER,
    });
  }

  // Pass 2: append rows for newly-discovered files (not in existing). For these,
  // pre-fill Purpose with the *first* marker's description as a starting point
  // for the human author; Symbol/Anchor and Tests stay as placeholders.
  const newRows = [];
  for (const d of discovered) {
    if (existingByFile.has(d.file)) continue;
    newRows.push({
      file: d.file,
      symbol: PLACEHOLDER,
      lines: d.lines,
      purpose: d.purpose || PLACEHOLDER,
      tests: rowGroup(d.file) === 2 ? 'Self' : PLACEHOLDER,
    });
  }
  newRows.sort(compareNewRows);

  return [...merged, ...newRows];
}

// ---------- render ----------

function renderTable(rows) {
  const header = '| File | Symbol/Anchor | Lines | Purpose | Tests |\n|---|---|---|---|---|';
  if (rows.length === 0) {
    return `\n${header}\n`;
  }
  const body = rows
    .map((r) => {
      const file = '`' + r.file + '`';
      const symbol = r.symbol || PLACEHOLDER;
      const lines = r.lines || PLACEHOLDER;
      const purpose = r.purpose || PLACEHOLDER;
      const tests = r.tests || PLACEHOLDER;
      return `| ${file} | ${symbol} | ${lines} | ${purpose} | ${tests} |`;
    })
    .join('\n');
  return `\n${header}\n${body}\n`;
}

// ---------- diff rendering ----------

function unifiedDiff(oldText, newText, label = 'SEAMS.md') {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const ops = lcsDiff(oldLines, newLines);
  const out = [];
  out.push(`${C.bold}--- a/${label}${C.reset}`);
  out.push(`${C.bold}+++ b/${label}${C.reset}`);
  for (const op of ops) {
    if (op.kind === 'eq') {
      out.push(`${C.dim} ${op.line}${C.reset}`);
    } else if (op.kind === 'del') {
      out.push(`${C.red}-${op.line}${C.reset}`);
    } else if (op.kind === 'add') {
      out.push(`${C.green}+${op.line}${C.reset}`);
    }
  }
  return out.join('\n');
}

function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  // For modest input sizes (auto-block is dozens of lines) the O(n*m) LCS is fine.
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'eq', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ kind: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', line: a[i++] });
  }
  while (j < m) {
    ops.push({ kind: 'add', line: b[j++] });
  }
  return ops;
}

function differs(oldText, newText) {
  return oldText !== newText;
}

// ---------- prompt ----------

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// ---------- file write (atomic) ----------

function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  // pid + random suffix prevents collisions if two invocations from the same
  // process (or container) race against each other.
  const suffix = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${suffix}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ---------- net-new files ----------

function splitNewBlock(md) {
  const ib = md.indexOf(SENTINEL_NEW_BEGIN);
  const ie = md.indexOf(SENTINEL_NEW_END);
  if (ib === -1 || ie === -1 || ie < ib) return { before: md, newBlock: null, after: '' };
  return {
    before: md.slice(0, ib + SENTINEL_NEW_BEGIN.length),
    newBlock: md.slice(ib + SENTINEL_NEW_BEGIN.length, ie),
    after: md.slice(ie),
  };
}

function parseNewFileRows(newBlock) {
  if (!newBlock) return [];
  const rows = [];
  const blockLines = newBlock.split('\n');
  for (let i = 0; i < blockLines.length; i++) {
    const raw = blockLines[i];
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    if (/^\|\s*-+\s*\|/.test(line)) continue;
    if (/^\|\s*File\s*\|/.test(line)) continue;
    const cells = splitTableCells(line);
    if (cells.length !== 4) {
      throw new Error(
        `SEAMS.md Net-New Files: row at block line ${i + 1} has ${cells.length} cell(s), expected 4. Row: "${line}"`,
      );
    }
    const file = stripBackticks(cells[0]);
    if (!file) {
      throw new Error(
        `SEAMS.md Net-New Files: row at block line ${i + 1} has empty File cell. Row: "${line}"`,
      );
    }
    rows.push({ file, imports: cells[1], risk: cells[2], tests: cells[3] });
  }
  return rows;
}

function isFileRegisteredInNewTable(file, rows) {
  const norm = file.replace(/\\/g, '/');
  for (const row of rows) {
    const pattern = row.file;
    if (pattern === norm) return true;
    if (pattern.includes('*')) {
      const starIdx = pattern.indexOf('*');
      const prefix = pattern.slice(0, starIdx);
      const suffix = pattern.slice(starIdx + 1);
      if (norm.startsWith(prefix) && norm.endsWith(suffix)) return true;
    }
  }
  return false;
}

function addedKnaufFiles(base) {
  let out;
  try {
    out = git(['diff', '--name-only', '--diff-filter=A', base]);
  } catch (e) {
    fail(`git diff (added files) failed: ${e.message}`);
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => classifyFile(f) === 'knauf-only');
}

function mergeNewFileRows(existing, added) {
  const newRows = added
    .filter((f) => !isFileRegisteredInNewTable(f, existing))
    .map((f) => ({ file: f, imports: PLACEHOLDER, risk: PLACEHOLDER, tests: PLACEHOLDER }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return [...existing, ...newRows];
}

function renderNewFilesTable(rows) {
  const header = '| File | Upstream Imports | Coupling Risk | Tests |\n|---|---|---|---|';
  if (rows.length === 0) return `\n${header}\n`;
  const body = rows
    .map(
      (r) =>
        `| \`${r.file}\` | ${r.imports || PLACEHOLDER} | ${r.risk || PLACEHOLDER} | ${r.tests || PLACEHOLDER} |`,
    )
    .join('\n');
  return `\n${header}\n${body}\n`;
}

// ---------- subcommands ----------

function resolveScope(flags) {
  if (flags.all) return { mode: 'all', files: walkAll() };
  const base = resolveDiffBase(flags.base);
  return { mode: 'diff', base, files: changedFiles(base) };
}

function discoverSeams(files) {
  const seams = [];
  const unpaired = [];
  for (const f of files) {
    if (classifyFile(f) !== 'upstream') continue;
    if (!isSourceFile(f)) continue;
    const r = scanFile(f);
    seams.push(...r.seams);
    unpaired.push(...r.unpaired);
  }
  return { seams, unpaired };
}

function cmdScan(flags) {
  const scope = resolveScope(flags);
  const { seams, unpaired } = discoverSeams(scope.files);
  if (flags.json) {
    process.stdout.write(
      JSON.stringify({ scope: scope.mode, base: scope.base || null, seams, unpaired }, null, 2) +
        '\n',
    );
    return 0;
  }
  console.log(
    `${C.bold}Seams discovered (${scope.mode}${scope.base ? ' base=' + scope.base.slice(0, 8) : ''}):${C.reset}`,
  );
  if (seams.length === 0) console.log(`  ${C.dim}(none)${C.reset}`);
  for (const s of seams) {
    console.log(
      `  ${C.cyan}${s.file}${C.reset}:${s.startLine}-${s.endLine}  ${s.description || C.dim + '(no description)' + C.reset}`,
    );
  }
  if (unpaired.length > 0) {
    console.log(`\n${C.yellow}Unpaired markers:${C.reset}`);
    for (const u of unpaired) console.log(`  ${u.file}:${u.line}  (${u.kind})`);
  }
  return 0;
}

function buildNewMd(currentMd, discoveredSeams, addedKnaufList = []) {
  // Step 1: update Inline Modifications block
  const inlineSplit = splitAutoBlock(currentMd);
  if (inlineSplit.autoBlock === null) {
    fail(
      'SEAMS.md is missing the seams:auto sentinels. ' +
        `Wrap the Inline Modifications table body with:\n  ${SENTINEL_BEGIN}\n  ...\n  ${SENTINEL_END}`,
    );
  }
  const existingRows = parseAutoBlockRows(inlineSplit.autoBlock);
  const discoveredRows = aggregateRows(discoveredSeams);
  const merged = mergeRows(existingRows, discoveredRows);
  // A row is "removed" when an existing manifest entry's file no longer has
  // any [knauf] markers. Surfacing this matters: silently dropping rows lets
  // an accidentally-deleted marker erase a seam from the manifest with no
  // trace in the SEAMS.md diff beyond a row disappearing.
  const mergedFiles = new Set(merged.map((r) => r.file));
  const removedRows = existingRows.filter((r) => !mergedFiles.has(r.file));
  const newAuto = renderTable(merged);
  let newMd = inlineSplit.before + newAuto + inlineSplit.after;

  // Step 2: update Net-New Files block (only when sentinels are present)
  let unregisteredNewFiles = [];
  const newFileSplit = splitNewBlock(newMd);
  if (newFileSplit.newBlock !== null && addedKnaufList.length > 0) {
    const existingNewRows = parseNewFileRows(newFileSplit.newBlock);
    unregisteredNewFiles = addedKnaufList.filter(
      (f) => !isFileRegisteredInNewTable(f, existingNewRows),
    );
    if (unregisteredNewFiles.length > 0) {
      const mergedNew = mergeNewFileRows(existingNewRows, addedKnaufList);
      newMd = newFileSplit.before + renderNewFilesTable(mergedNew) + newFileSplit.after;
    }
  }

  return {
    oldMd: currentMd,
    newMd,
    existingRows,
    discoveredRows,
    mergedRows: merged,
    removedRows,
    unregisteredNewFiles,
  };
}

async function cmdWrite(flags) {
  // `write` always operates on the whole repo — the SEAMS.md manifest is global.
  // `--diff` / `--all` are not honored here; see `usage()`. Only `--base` matters
  // (for picking up added knauf-only files in the Net-New Files block).
  if (flags.diff || flags.all) {
    console.error(
      `${C.yellow}warning:${C.reset} \`write\` ignores --diff/--all; it always scans the whole repo. ` +
        `Use \`scan\` for scoped output.`,
    );
  }
  const { seams: allDiscovered, unpaired } = discoverSeams(walkAll());
  const added = addedKnaufFiles(resolveDiffBase(flags.base));

  const currentMd = readSeamsMd();
  const result = buildNewMd(currentMd, allDiscovered, added);

  if (unpaired.length > 0) {
    console.log(`${C.yellow}Warning: unpaired [knauf] markers (won't be in the table):${C.reset}`);
    for (const u of unpaired) console.log(`  ${u.file}:${u.line}  (${u.kind})`);
    console.log('');
  }

  if (result.removedRows.length > 0) {
    console.log(
      `${C.yellow}Warning: ${result.removedRows.length} row(s) will be removed (file no longer has [knauf] markers):${C.reset}`,
    );
    for (const r of result.removedRows) console.log(`  ${C.red}- ${r.file}${C.reset}`);
    console.log(
      `${C.dim}If a marker was accidentally deleted, restore it before running write. ` +
        `Otherwise this is the intended seam removal.${C.reset}\n`,
    );
  }

  if (!differs(result.oldMd, result.newMd)) {
    console.log(`${C.green}SEAMS.md is up to date.${C.reset}`);
    return 0;
  }

  const inlineSplit = splitAutoBlock(result.oldMd);
  const newInlineSplit = splitAutoBlock(result.newMd);
  if (differs(inlineSplit.autoBlock, newInlineSplit.autoBlock)) {
    console.log(
      unifiedDiff(
        inlineSplit.autoBlock,
        newInlineSplit.autoBlock,
        'SEAMS.md (Inline Modifications)',
      ),
    );
    console.log('');
  }

  const netNewSplit = splitNewBlock(result.oldMd);
  const newNetNewSplit = splitNewBlock(result.newMd);
  if (netNewSplit.newBlock !== null && differs(netNewSplit.newBlock, newNetNewSplit.newBlock)) {
    console.log(
      unifiedDiff(netNewSplit.newBlock, newNetNewSplit.newBlock, 'SEAMS.md (Net-New Files)'),
    );
    console.log('');
  }

  if (flags['dry-run']) {
    console.log(
      `${C.yellow}Drift detected. Run \`node knauf/scripts/seams.js write\` to apply.${C.reset}`,
    );
    return 1;
  }

  let approved = !!flags.yes;
  if (!approved) {
    if (!process.stdin.isTTY) {
      fail('write requires an interactive terminal (or pass --yes).');
    }
    approved = await promptYesNo('Apply these changes to SEAMS.md?');
  }

  if (!approved) {
    console.log(`${C.dim}No changes written.${C.reset}`);
    return 0;
  }

  writeAtomic(SEAMS_PATH, result.newMd);
  console.log(`${C.green}SEAMS.md updated.${C.reset}`);
  return 0;
}

function cmdCheck(flags) {
  if (flags.diff || flags.all) {
    console.error(
      `${C.yellow}warning:${C.reset} \`check\` ignores --diff/--all; it always scans the whole repo.`,
    );
  }
  const seams = discoverSeams(walkAll()).seams;
  const currentMd = readSeamsMd();
  const result = buildNewMd(currentMd, seams);
  const inSync = !differs(result.oldMd, result.newMd);

  if (flags.json) {
    const payload = {
      command: 'check',
      inSync,
      removedRows: result.removedRows.map((r) => r.file),
      unregisteredNewFiles: result.unregisteredNewFiles || [],
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
    return inSync ? 0 : 1;
  }

  if (inSync) {
    console.log(`${C.green}SEAMS.md is in sync with [knauf] markers.${C.reset}`);
    return 0;
  }
  const split = splitAutoBlock(result.oldMd);
  const newSplit = splitAutoBlock(result.newMd);
  console.log(unifiedDiff(split.autoBlock, newSplit.autoBlock, 'SEAMS.md (Inline Modifications)'));
  console.log('');
  console.log(
    `${C.red}SEAMS.md is out of sync. Run \`node knauf/scripts/seams.js write\`.${C.reset}`,
  );
  if (process.env.GITHUB_ACTIONS) {
    console.log(
      '::error file=SEAMS.md::SEAMS.md is out of sync with [knauf] markers. Run `node knauf/scripts/seams.js write` locally and commit.',
    );
  }
  return 1;
}

function cmdDiffCheck(flags) {
  const base = resolveDiffBase(flags.base);
  const changed = changedFiles(base);
  const offenders = [];

  for (const f of changed) {
    if (classifyFile(f) !== 'upstream') continue;
    // Only code/Dockerfile files need [knauf] markers.
    if (!isSourceFile(f)) continue;
    // Only check files that still exist (deleted upstream files don't need tags).
    const abs = path.join(REPO_ROOT, f);
    if (!fs.existsSync(abs)) continue;
    if (!fileHasMarker(f)) offenders.push(f);
  }

  // Detect added knauf-only files not registered in Net-New Files.
  const added = addedKnaufFiles(base);
  const currentMd = readSeamsMd();
  const newFileSplit = splitNewBlock(currentMd);
  const existingNewRows =
    newFileSplit.newBlock !== null ? parseNewFileRows(newFileSplit.newBlock) : [];
  const unregistered = added.filter((f) => !isFileRegisteredInNewTable(f, existingNewRows));

  if (flags.json) {
    const payload = {
      command: 'diff-check',
      base,
      changedFileCount: changed.length,
      untaggedUpstreamFiles: offenders,
      unregisteredNewFiles: unregistered,
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
    return offenders.length === 0 && unregistered.length === 0 ? 0 : 1;
  }

  console.log(
    `${C.bold}Diff-check (base ${base.slice(0, 12)}):${C.reset} ${changed.length} changed file(s)`,
  );

  if (offenders.length === 0 && unregistered.length === 0) {
    console.log(`${C.green}All modified upstream files have [knauf] markers.${C.reset}`);
    if (added.length > 0) {
      console.log(
        `${C.green}All added knauf-only files are registered in Net-New Files.${C.reset}`,
      );
    }
    return 0;
  }

  let exitCode = 0;

  if (offenders.length > 0) {
    exitCode = 1;
    console.log(
      `\n${C.red}${offenders.length} upstream-class file(s) modified without a [knauf] marker:${C.reset}`,
    );
    for (const f of offenders) {
      console.log(`  ${C.red}✗${C.reset} ${f}`);
      if (process.env.GITHUB_ACTIONS) {
        console.log(
          `::error file=${f}::modified upstream file has no [knauf] marker. See CUSTOMIZATION_STRATEGY.md.`,
        );
      }
    }
    console.log(
      `\n${C.dim}If the change is intentional, add a paired [knauf]/End [knauf] block at the seam ` +
        `and run \`node knauf/scripts/seams.js write\`. If the file is Knauf-only, move it under a knauf/ directory.${C.reset}`,
    );
  }

  if (unregistered.length > 0) {
    exitCode = 1;
    console.log(
      `\n${C.yellow}${unregistered.length} added knauf-only file(s) not in Net-New Files table:${C.reset}`,
    );
    for (const f of unregistered) {
      console.log(`  ${C.yellow}+${C.reset} ${f}`);
      if (process.env.GITHUB_ACTIONS) {
        console.log(
          `::warning file=${f}::new knauf-only file not registered in SEAMS.md Net-New Files. Run \`node knauf/scripts/seams.js write\`.`,
        );
      }
    }
    if (newFileSplit.newBlock === null) {
      console.log(
        `\n${C.dim}Add ${SENTINEL_NEW_BEGIN} / ${SENTINEL_NEW_END} sentinels around the Net-New Files table in SEAMS.md to enable auto-registration.${C.reset}`,
      );
    } else {
      console.log(
        `\n${C.dim}Run \`node knauf/scripts/seams.js write\` to register them.${C.reset}`,
      );
    }
  }

  return exitCode;
}

// ---------- entry ----------

function fail(msg) {
  console.error(`${C.red}error:${C.reset} ${msg}`);
  process.exit(2);
}

function usage() {
  return `Usage: node knauf/scripts/seams.js <command> [flags]

Commands and the flags they honor:
  scan         list discovered [knauf] seams
                 --diff               default; changed files vs merge-base of default branch
                 --all                scan the whole repo
                 --base=<ref>         override the diff base (commit, tag, branch)
                 --json               emit JSON instead of human output
  write        interactive update of SEAMS.md (always whole-repo)
                 --base=<ref>         override the diff base used to detect added knauf-only files
                 --dry-run            preview only, exit 1 on drift
                 --yes                skip the approval prompt
  check        exit 1 if SEAMS.md is out of sync (always whole-repo)
  diff-check   exit 1 if any modified upstream file lacks a [knauf] marker
                 --base=<ref>         override the diff base

Environment:
  SEAMS_BASE_REF   override the default branch used for merge-base lookups
                   (otherwise: origin/HEAD, then main, then master).
  GITHUB_ACTIONS   when set, check/diff-check emit ::error annotations.

Exit codes:
  0  success / no drift
  1  drift detected (check, diff-check, --dry-run)
  2  internal error (git failure, parser failure, missing files)`;
}

async function main(argv) {
  const args = parseArgv(argv);
  const cmd = args._[0];

  if (!cmd || args.flags.help) {
    console.log(usage());
    return cmd ? 0 : 2;
  }

  try {
    if (cmd === 'scan') return cmdScan(args.flags);
    if (cmd === 'write') return await cmdWrite(args.flags);
    if (cmd === 'check') return cmdCheck(args.flags);
    if (cmd === 'diff-check') return cmdDiffCheck(args.flags);
    console.error(`unknown command: ${cmd}\n`);
    console.error(usage());
    return 2;
  } catch (e) {
    if (e && e.code === 'ENOENT') fail(`missing file or command: ${e.message}`);
    fail(e && e.message ? e.message : String(e));
  }
}

// Only run as a CLI when invoked directly. Required so the spec file can
// require() this module without triggering the command dispatcher.
if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e && e.stack ? e.stack : e);
      process.exit(2);
    },
  );
}

// Test surface: pure-ish functions that don't touch git or stdin.
// The CLI dispatch lives behind `main`. Anything not listed here is
// considered internal — tests should not depend on it.
module.exports = {
  main,
  parseArgv,
  classifyFile,
  isSourceFile,
  scanFile,
  cleanDescription,
  aggregateRows,
  mergeRows,
  splitAutoBlock,
  splitNewBlock,
  parseAutoBlockRows,
  parseNewFileRows,
  splitTableCells,
  stripBackticks,
  isFileRegisteredInNewTable,
  mergeNewFileRows,
  renderTable,
  renderNewFilesTable,
  buildNewMd,
  lcsDiff,
  unifiedDiff,
  resolveDefaultBranch,
};
