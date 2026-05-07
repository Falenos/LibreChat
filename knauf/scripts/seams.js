#!/usr/bin/env node
// @ts-nocheck
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
const { execSync } = require('child_process');
const readline = require('readline');

const REPO_ROOT = path.resolve(__dirname, '..');
const SEAMS_PATH = path.join(REPO_ROOT, 'SEAMS.md');
const SENTINEL_BEGIN = '<!-- seams:auto:begin -->';
const SENTINEL_END = '<!-- seams:auto:end -->';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.css']);

const TTY = process.stdout.isTTY;
const C = {
  red: TTY ? '\x1b[31m' : '',
  green: TTY ? '\x1b[32m' : '',
  yellow: TTY ? '\x1b[33m' : '',
  cyan: TTY ? '\x1b[36m' : '',
  dim: TTY ? '\x1b[2m' : '',
  bold: TTY ? '\x1b[1m' : '',
  reset: TTY ? '\x1b[0m' : '',
};

// ---------- argv ----------

function parseArgv(argv) {
  const args = { _: [], flags: {} };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) args.flags[a.slice(2)] = true;
      else args.flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ---------- file classification ----------

const KNAUF_DIRS = [
  'api/knauf/',
  'api/server/routes/knauf/',
  'client/src/knauf/',
  'packages/knauf/',
  'assets/knauf/',
];

const CONFIG_FILES = new Set([
  'librechat.yaml',
  'docker-compose.override.yml',
]);

const UPSTREAM_PREFIXES = [
  'api/',
  'client/',
  'packages/api/',
  'packages/client/',
  'packages/data-provider/',
  'packages/data-schemas/',
];

const META_PREFIXES = ['.github/', '.husky/', '.vscode/', '.do/', '.devcontainer/'];
const IGNORE_PREFIXES = ['node_modules/', 'dist/', 'build/', '.turbo/', '.git/'];
const LOCKFILES = new Set(['bun.lock', 'package-lock.json', 'yarn.lock']);

/**
 * Returns one of: 'knauf-only', 'config', 'meta', 'upstream', 'ignore'.
 * The 'upstream' class is the only one that requires a [knauf] marker when modified.
 */
function classifyFile(p) {
  const norm = p.replace(/\\/g, '/');

  if (IGNORE_PREFIXES.some((d) => norm.startsWith(d))) return 'ignore';
  if (norm.includes('/node_modules/')) return 'ignore';

  if (KNAUF_DIRS.some((d) => norm.startsWith(d))) return 'knauf-only';
  // Defensive: any path component named `knauf` (matches the
  // `--exclude-dir='knauf'` semantics of the original validator grep).
  if (/(^|\/)knauf\//.test(norm)) return 'knauf-only';

  if (CONFIG_FILES.has(norm)) return 'config';
  if (norm.startsWith('.env')) return 'config';
  if (/^Dockerfile(\.|$)/.test(norm)) return 'config';

  if (META_PREFIXES.some((d) => norm.startsWith(d))) return 'meta';
  if (LOCKFILES.has(norm)) return 'meta';
  // Top-level markdown / config files (CLAUDE.md, README.md, AGENTS.md, SEAMS.md, etc.)
  if (!norm.includes('/') && (norm.endsWith('.md') || norm === 'turbo.json' || norm === '.prettierrc' || norm === '.gitignore' || norm === '.gitattributes' || norm === '.nvmrc' || norm === '.dockerignore' || norm === 'LICENSE')) {
    return 'meta';
  }
  // Top-level package.json is meta (it's repo glue, not upstream code)
  if (norm === 'package.json') return 'meta';
  // scripts/ is local tooling
  if (norm.startsWith('scripts/')) return 'meta';

  if (UPSTREAM_PREFIXES.some((d) => norm.startsWith(d))) return 'upstream';

  // Unknown top-level files default to meta — won't trigger the tag requirement.
  return 'meta';
}

// ---------- git ----------

function git(args, opts = {}) {
  return execSync(`git ${args}`, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', opts.quiet ? 'ignore' : 'pipe'],
    ...opts,
  });
}

function resolveDiffBase(explicit) {
  if (explicit) return explicit.trim();
  try {
    return git('merge-base main HEAD').trim();
  } catch (e) {
    fail(`could not resolve diff base (git merge-base main HEAD failed): ${e.message}`);
  }
}

function changedFiles(base) {
  // `git diff --name-only <base>` (no `..` or `...`) means "working tree vs base",
  // which is the union of committed + staged + unstaged changes. Locally this
  // catches uncommitted edits; in CI the working tree equals HEAD, so the
  // result matches a PR-style three-dot diff against `<base>`.
  let out;
  try {
    out = git(`diff --name-only --diff-filter=ACMR ${base}`);
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
  return files
    .map((abs) => path.relative(REPO_ROOT, abs).replace(/\\/g, '/'))
    .filter((rel) => SOURCE_EXTENSIONS.has(path.extname(rel)));
}

function walkDir(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'build' || ent.name === '.turbo') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkDir(full, out);
    else if (ent.isFile()) out.push(full);
  }
}

// ---------- marker scanning ----------

const OPEN_RE = /(?:\/\/|\/\*|\{\/\*|#)\s*\[knauf\]\s*([^\n*]*?)(?:\*\/\}?|$)/;
const CLOSE_RE = /(?:\/\/|\/\*|\{\/\*|#)\s*End\s+\[knauf\][^\n]*/;

function scanFile(rel) {
  const abs = path.join(REPO_ROOT, rel);
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { seams: [], unpaired: [], missing: true };
  }
  const lines = content.split('\n');
  const seams = [];
  const unpaired = [];
  const stack = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (CLOSE_RE.test(line)) {
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
    const m = line.match(OPEN_RE);
    if (m) {
      // Skip if the marker is "End [knauf]" — already handled above.
      if (/End\s+\[knauf\]/.test(line)) continue;
      stack.push({ line: i + 1, description: cleanDescription(m[1]) });
    }
  }
  for (const open of stack) {
    unpaired.push({ file: rel, line: open.line, kind: 'open-without-close' });
  }
  return { seams, unpaired, missing: false };
}

function cleanDescription(raw) {
  if (!raw) return '';
  return raw
    .replace(/\*+\/?$/, '')
    .replace(/\}\s*$/, '')
    .replace(/^[\s:.\-—]+/, '')
    .replace(/[\s*\-—:]+$/, '')
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
 */
function parseAutoBlockRows(autoBlock) {
  if (!autoBlock) return [];
  const rows = [];
  for (const raw of autoBlock.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    if (/^\|\s*-+\s*\|/.test(line)) continue; // markdown header separator
    if (/^\|\s*File\s*\|/.test(line)) continue; // header row
    const cells = splitTableCells(line);
    if (cells.length < 5) continue;
    const file = stripBackticks(cells[0]);
    if (!file) continue;
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
  const body = rows.map((r) => {
    const file = '`' + r.file + '`';
    const symbol = r.symbol || PLACEHOLDER;
    const lines = r.lines || PLACEHOLDER;
    const purpose = r.purpose || PLACEHOLDER;
    const tests = r.tests || PLACEHOLDER;
    return `| ${file} | ${symbol} | ${lines} | ${purpose} | ${tests} |`;
  }).join('\n');
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
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: 'eq', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ kind: 'del', line: a[i] }); i++; }
    else { ops.push({ kind: 'add', line: b[j] }); j++; }
  }
  while (i < n) { ops.push({ kind: 'del', line: a[i++] }); }
  while (j < m) { ops.push({ kind: 'add', line: b[j++] }); }
  return ops;
}

function hasNonContextChanges(oldText, newText) {
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
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
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
    if (!SOURCE_EXTENSIONS.has(path.extname(f))) continue;
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
    process.stdout.write(JSON.stringify({ scope: scope.mode, base: scope.base || null, seams, unpaired }, null, 2) + '\n');
    return 0;
  }
  console.log(`${C.bold}Seams discovered (${scope.mode}${scope.base ? ' base=' + scope.base.slice(0, 8) : ''}):${C.reset}`);
  if (seams.length === 0) console.log(`  ${C.dim}(none)${C.reset}`);
  for (const s of seams) {
    console.log(`  ${C.cyan}${s.file}${C.reset}:${s.startLine}-${s.endLine}  ${s.description || C.dim + '(no description)' + C.reset}`);
  }
  if (unpaired.length > 0) {
    console.log(`\n${C.yellow}Unpaired markers:${C.reset}`);
    for (const u of unpaired) console.log(`  ${u.file}:${u.line}  (${u.kind})`);
  }
  return 0;
}

function buildNewMd(currentMd, discoveredSeams) {
  const split = splitAutoBlock(currentMd);
  if (split.autoBlock === null) {
    fail(
      'SEAMS.md is missing the seams:auto sentinels. ' +
      `Wrap the Inline Modifications table body with:\n  ${SENTINEL_BEGIN}\n  ...\n  ${SENTINEL_END}`,
    );
  }
  const existingRows = parseAutoBlockRows(split.autoBlock);
  const discoveredRows = aggregateRows(discoveredSeams);
  const merged = mergeRows(existingRows, discoveredRows);
  const newAuto = renderTable(merged);
  return {
    oldMd: currentMd,
    newMd: split.before + newAuto + split.after,
    existingRows,
    discoveredRows,
    mergedRows: merged,
  };
}

async function cmdWrite(flags) {
  const scope = resolveScope(flags);
  const { seams, unpaired } = discoverSeams(flags.all ? walkAll() : scope.files);

  // Always operate on the full repo for write/check — the SEAMS.md table is a
  // global manifest. The scope flag only affects which warnings we surface.
  const allDiscovered = flags.all ? seams : discoverSeams(walkAll()).seams;

  const currentMd = readSeamsMd();
  const result = buildNewMd(currentMd, allDiscovered);

  if (unpaired.length > 0) {
    console.log(`${C.yellow}Warning: unpaired [knauf] markers (won't be in the table):${C.reset}`);
    for (const u of unpaired) console.log(`  ${u.file}:${u.line}  (${u.kind})`);
    console.log('');
  }

  if (!hasNonContextChanges(result.oldMd, result.newMd)) {
    console.log(`${C.green}SEAMS.md is up to date.${C.reset}`);
    return 0;
  }

  const split = splitAutoBlock(result.oldMd);
  const newSplit = splitAutoBlock(result.newMd);
  console.log(unifiedDiff(split.autoBlock, newSplit.autoBlock, 'SEAMS.md (Inline Modifications)'));
  console.log('');

  if (flags['dry-run']) {
    console.log(`${C.yellow}Drift detected. Run \`node knauf/scripts/seams.js write\` to apply.${C.reset}`);
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
  const seams = discoverSeams(walkAll()).seams;
  const currentMd = readSeamsMd();
  const result = buildNewMd(currentMd, seams);
  if (!hasNonContextChanges(result.oldMd, result.newMd)) {
    console.log(`${C.green}SEAMS.md is in sync with [knauf] markers.${C.reset}`);
    return 0;
  }
  const split = splitAutoBlock(result.oldMd);
  const newSplit = splitAutoBlock(result.newMd);
  console.log(unifiedDiff(split.autoBlock, newSplit.autoBlock, 'SEAMS.md (Inline Modifications)'));
  console.log('');
  console.log(`${C.red}SEAMS.md is out of sync. Run \`node knauf/scripts/seams.js write\`.${C.reset}`);
  return 1;
}

function cmdDiffCheck(flags) {
  const base = resolveDiffBase(flags.base);
  const changed = changedFiles(base);
  const offenders = [];

  for (const f of changed) {
    if (classifyFile(f) !== 'upstream') continue;
    // Only code files need [knauf] markers. Matches the original validator's
    // grep filter: `--include='*.js' --include='*.ts' --include='*.tsx'
    // --include='*.jsx' --include='*.css'`. Documentation, JSON fixtures,
    // images, etc. inside upstream directories are not seams.
    if (!SOURCE_EXTENSIONS.has(path.extname(f))) continue;
    // Only check files that still exist (deleted upstream files don't need tags).
    const abs = path.join(REPO_ROOT, f);
    if (!fs.existsSync(abs)) continue;
    if (!fileHasMarker(f)) offenders.push(f);
  }

  console.log(`${C.bold}Diff-check (base ${base.slice(0, 12)}):${C.reset} ${changed.length} changed file(s)`);

  if (offenders.length === 0) {
    console.log(`${C.green}All modified upstream files have [knauf] markers.${C.reset}`);
    return 0;
  }

  console.log(`\n${C.red}${offenders.length} upstream-class file(s) modified without a [knauf] marker:${C.reset}`);
  for (const f of offenders) {
    console.log(`  ${C.red}✗${C.reset} ${f}`);
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::error file=${f}::modified upstream file has no [knauf] marker. See CUSTOMIZATION_STRATEGY.md.`);
    }
  }
  console.log(
    `\n${C.dim}If the change is intentional, add a paired [knauf]/End [knauf] block at the seam ` +
    `and run \`node knauf/scripts/seams.js write\`. If the file is Knauf-only, move it under a knauf/ directory.${C.reset}`,
  );
  return 1;
}

// ---------- entry ----------

function fail(msg) {
  console.error(`${C.red}error:${C.reset} ${msg}`);
  process.exit(2);
}

function usage() {
  return `Usage: node knauf/scripts/seams.js <command> [flags]

Commands:
  scan        list discovered [knauf] seams
  write       interactive update of SEAMS.md
  check       exit 1 if SEAMS.md is out of sync
  diff-check  exit 1 if any modified upstream file lacks a [knauf] marker

Flags:
  --diff           changed files vs merge-base of main (default for scan)
  --all            scan whole repo (default for write/check)
  --base=<ref>     override the diff base
  --json           scan: emit JSON
  --dry-run        write: preview only, exit 1 on drift
  --yes            write: skip the approval prompt`;
}

(async () => {
  const args = parseArgv(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || args.flags.help) {
    console.log(usage());
    process.exit(cmd ? 0 : 2);
  }

  try {
    let code = 0;
    if (cmd === 'scan') code = cmdScan(args.flags);
    else if (cmd === 'write') code = await cmdWrite(args.flags);
    else if (cmd === 'check') code = cmdCheck(args.flags);
    else if (cmd === 'diff-check') code = cmdDiffCheck(args.flags);
    else {
      console.error(`unknown command: ${cmd}\n`);
      console.error(usage());
      process.exit(2);
    }
    process.exit(code);
  } catch (e) {
    if (e && e.code === 'ENOENT') fail(`missing file or command: ${e.message}`);
    fail(e && e.message ? e.message : String(e));
  }
})();
