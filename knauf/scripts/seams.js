#!/usr/bin/env node
// @ts-check
//
// knauf/scripts/seams.js — CLI entry for the [knauf] seam manifest tool
//
// Authors and validates the [knauf] seam manifest in SEAMS.md.
//
// Subcommands:
//   scan        list discovered seams (default scope: --diff)
//   write       interactive update of SEAMS.md
//   check       exit 1 if SEAMS.md is out of sync (always whole-repo)
//   diff-check  exit 1 if any modified upstream file lacks a [knauf] marker
//
// See `seams.js --help` for flags and environment variables.
//
// Architecture: this file is the CLI shell. All real work lives in lib/.
// Pure functions are re-exported at the bottom so the spec can require them.

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs: nodeParseArgs } = require('node:util');

// ---------- Node version guard ----------

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

// ---------- repo root resolution ----------

function findRepoRoot(startDir) {
  let dir = startDir;
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

// ---------- lib imports ----------

const { classifyFile, isSourceFile } = require('./lib/classify.js');
const { makeGit } = require('./lib/git.js');
// makeScanner returns a bound `scanFile`/`fileHasMarker` pair; cleanDescription is
// the pure standalone we re-export for the spec.
const { makeScanner, cleanDescription } = require('./lib/scan.js');
const { makeWalker } = require('./lib/walk.js');
const { isFileRegisteredInNewTable } = require('./lib/glob.js');
const { lcsDiff, unifiedDiff, differs } = require('./lib/diff.js');
const { writeAtomic, promptYesNo, makePalette } = require('./lib/io.js');
const {
  SENTINEL_BEGIN,
  SENTINEL_END,
  readSeamsMd,
  splitAutoBlock,
  splitNewBlock,
  splitTableCells,
  stripBackticks,
  parseAutoBlockRows,
  parseNewFileRows,
  renderTable,
  renderNewFilesTable,
} = require('./lib/manifest.js');
const { aggregateRows, rowGroup, mergeRows, mergeNewFileRows } = require('./lib/merge.js');

// ---------- bound helpers (lib factories that need REPO_ROOT / fail) ----------

const C = makePalette();
function fail(msg) {
  console.error(`${C.red}error:${C.reset} ${msg}`);
  process.exit(2);
}
const { resolveDefaultBranch, resolveDiffBase, changedFiles, addedFiles } = makeGit(REPO_ROOT);
const { scanFile, fileHasMarker } = makeScanner(REPO_ROOT);
const { walkAll } = makeWalker(REPO_ROOT);

// ---------- argv ----------

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

// ---------- discovery / orchestration ----------

function resolveScope(flags) {
  if (flags.all) return { mode: 'all', files: walkAll() };
  const base = resolveDiffBaseOr(flags.base);
  return { mode: 'diff', base, files: changedFiles(base, fail) };
}

// resolveDiffBase calls fail() on error, which exits the process — so the
// return value is always a string by the time this returns. The non-null
// assertion below tells the type checker that.
function resolveDiffBaseOr(explicit) {
  const r = resolveDiffBase(explicit, fail);
  return /** @type {string} */ (r);
}

function addedKnaufFiles(base) {
  return addedFiles(base, fail).filter((f) => classifyFile(f) === 'knauf-only');
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

function buildNewMd(currentMd, discoveredSeams, addedKnaufList = []) {
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
  const mergedFiles = new Set(merged.map((r) => r.file));
  const removedRows = existingRows.filter((r) => !mergedFiles.has(r.file));
  const newAuto = renderTable(merged);
  let newMd = inlineSplit.before + newAuto + inlineSplit.after;

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

// ---------- subcommands ----------

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

async function cmdWrite(flags) {
  if (flags.diff || flags.all) {
    console.error(
      `${C.yellow}warning:${C.reset} \`write\` ignores --diff/--all; it always scans the whole repo. ` +
        `Use \`scan\` for scoped output.`,
    );
  }
  const { seams: allDiscovered, unpaired } = discoverSeams(walkAll());
  const added = addedKnaufFiles(resolveDiffBaseOr(flags.base));

  const currentMd = readSeamsMd(SEAMS_PATH, fail);
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
        C,
      ),
    );
    console.log('');
  }

  const netNewSplit = splitNewBlock(result.oldMd);
  const newNetNewSplit = splitNewBlock(result.newMd);
  if (netNewSplit.newBlock !== null && differs(netNewSplit.newBlock, newNetNewSplit.newBlock)) {
    console.log(
      unifiedDiff(netNewSplit.newBlock, newNetNewSplit.newBlock, 'SEAMS.md (Net-New Files)', C),
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
    if (!process.stdin.isTTY) fail('write requires an interactive terminal (or pass --yes).');
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
  const currentMd = readSeamsMd(SEAMS_PATH, fail);
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
  console.log(
    unifiedDiff(split.autoBlock, newSplit.autoBlock, 'SEAMS.md (Inline Modifications)', C),
  );
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
  const base = resolveDiffBaseOr(flags.base);
  const changed = changedFiles(base, fail);
  const offenders = [];

  for (const f of changed) {
    if (classifyFile(f) !== 'upstream') continue;
    if (!isSourceFile(f)) continue;
    const abs = path.join(REPO_ROOT, f);
    if (!fs.existsSync(abs)) continue;
    if (!fileHasMarker(f)) offenders.push(f);
  }

  const added = addedKnaufFiles(base);
  const currentMd = readSeamsMd(SEAMS_PATH, fail);
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
        `\n${C.dim}Add the seams:new sentinels around the Net-New Files table in SEAMS.md to enable auto-registration.${C.reset}`,
      );
    } else {
      console.log(
        `\n${C.dim}Run \`node knauf/scripts/seams.js write\` to register them.${C.reset}`,
      );
    }
  }

  return exitCode;
}

// ---------- usage / dispatch ----------

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
                 --json               emit JSON instead of human output
  diff-check   exit 1 if any modified upstream file lacks a [knauf] marker
                 --base=<ref>         override the diff base
                 --json               emit JSON instead of human output

Environment:
  SEAMS_BASE_REF   override the default branch used for merge-base lookups
                   (otherwise: origin/HEAD, then main, then master).
  GITHUB_ACTIONS   when set, check/diff-check emit ::error annotations.
  NO_COLOR         disable ANSI colors (https://no-color.org).
  FORCE_COLOR      enable ANSI colors even on non-TTY (https://force-color.org).

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
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err && err.code === 'ENOENT') fail(`missing file or command: ${err.message}`);
    fail(err && err.message ? err.message : String(err));
  }
}

// ---------- entry ----------

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e && e.stack ? e.stack : e);
      process.exit(2);
    },
  );
}

// Re-exports for the spec. Each lib module is its own canonical home; this
// surface is back-compat scaffolding so the existing spec keeps working.
module.exports = {
  main,
  parseArgv,
  buildNewMd,
  // classify
  classifyFile,
  isSourceFile,
  // scan
  scanFile,
  cleanDescription,
  // manifest
  splitAutoBlock,
  splitNewBlock,
  parseAutoBlockRows,
  parseNewFileRows,
  splitTableCells,
  stripBackticks,
  renderTable,
  renderNewFilesTable,
  // merge
  aggregateRows,
  mergeRows,
  mergeNewFileRows,
  rowGroup,
  // glob
  isFileRegisteredInNewTable,
  // diff
  lcsDiff,
  unifiedDiff,
  differs,
  // git
  resolveDefaultBranch,
};
