// @ts-check
//
// git.js — typed argv-array wrapper around spawnSync git
//
// All callers pass `args` as an array — never a template string. This bypasses
// the shell entirely, so refs like `HEAD; rm -rf ~` arriving via `--base=<ref>`
// are treated as a single ambiguous revision instead of executing.

'use strict';

const { spawnSync } = require('child_process');

function makeGit(repoRoot) {
  function git(args, opts = {}) {
    if (!Array.isArray(args)) {
      throw new TypeError(`git() requires an args array, got ${typeof args}`);
    }
    const r = spawnSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', opts.quiet ? 'ignore' : 'pipe'],
    });
    if (r.error) throw r.error;
    if (r.status !== 0) {
      const stderr = (r.stderr || '').trim();
      const err = new Error(
        `git ${args.join(' ')} exited ${r.status}${stderr ? `: ${stderr}` : ''}`,
      );
      // @ts-ignore — augment error with exit status for callers
      err.status = r.status;
      throw err;
    }
    return r.stdout;
  }

  // Resolve the repo's default branch.
  //   1. SEAMS_BASE_REF env var (explicit override)
  //   2. `origin/HEAD` symbolic ref (canonical)
  //   3. First of `main`, `master` that exists locally
  //   4. Hard fallback to `main`
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

  function resolveDiffBase(explicit, onFail) {
    if (explicit) return String(explicit).trim();
    const branch = resolveDefaultBranch();
    try {
      return git(['merge-base', branch, 'HEAD']).trim();
    } catch (e) {
      onFail(`could not resolve diff base (git merge-base ${branch} HEAD failed): ${e.message}`);
    }
  }

  // Files changed in working tree vs <base>. The two-dot form (no `..` or `...`)
  // means "working tree vs base" — the union of committed + staged + unstaged.
  // In CI, working tree === HEAD, so the result matches a PR three-dot diff.
  function changedFiles(base, onFail) {
    let out;
    try {
      out = git(['diff', '--name-only', '--diff-filter=ACMR', base]);
    } catch (e) {
      onFail(`git diff failed against base ${base}: ${e.message}`);
    }
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  function addedFiles(base, onFail) {
    let out;
    try {
      out = git(['diff', '--name-only', '--diff-filter=A', base]);
    } catch (e) {
      onFail(`git diff (added files) failed: ${e.message}`);
    }
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  return { git, resolveDefaultBranch, resolveDiffBase, changedFiles, addedFiles };
}

module.exports = { makeGit };
