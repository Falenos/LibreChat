// @ts-check
//
// diff.js — zero-deps unified diff with hunk markers and context trimming
//
// Output mirrors `git diff -U<context>`:
//   --- a/<label>
//   +++ b/<label>
//   @@ -<oldStart>,<oldCount> +<newStart>,<newCount> @@
//    context line
//   -removed line
//   +added line
//
// LCS is O(n*m). The auto-block table is dozens of lines, so this is fine.

'use strict';

const CONTEXT_LINES = 3;

function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
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
  while (i < n) ops.push({ kind: 'del', line: a[i++] });
  while (j < m) ops.push({ kind: 'add', line: b[j++] });
  return ops;
}

// Group ops into hunks. A hunk is a contiguous region with changes, plus
// CONTEXT_LINES of unchanged context on each side. Adjacent hunks within
// 2*CONTEXT_LINES of each other get merged. Pure-context regions outside
// any hunk are omitted from output.
function buildHunks(ops) {
  // First pass: index of every change (non-eq) op.
  const changeIdxs = [];
  for (let i = 0; i < ops.length; i++) if (ops[i].kind !== 'eq') changeIdxs.push(i);
  if (changeIdxs.length === 0) return [];

  // Second pass: collapse change-indexes into ranges.
  const ranges = [];
  let start = changeIdxs[0];
  let end = changeIdxs[0];
  for (let k = 1; k < changeIdxs.length; k++) {
    if (changeIdxs[k] - end <= 2 * CONTEXT_LINES) {
      end = changeIdxs[k];
    } else {
      ranges.push([start, end]);
      start = changeIdxs[k];
      end = changeIdxs[k];
    }
  }
  ranges.push([start, end]);

  // Third pass: expand each range with context and produce hunk ops.
  const hunks = [];
  for (const [s, e] of ranges) {
    const from = Math.max(0, s - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, e + CONTEXT_LINES);
    hunks.push({ from, to, ops: ops.slice(from, to + 1) });
  }
  return hunks;
}

// Compute the @@ header for a hunk. Line numbers are 1-based, per unified
// diff convention.
function hunkHeader(hunkOps, oldStart, newStart) {
  let oldCount = 0;
  let newCount = 0;
  for (const op of hunkOps) {
    if (op.kind === 'eq') {
      oldCount++;
      newCount++;
    } else if (op.kind === 'del') {
      oldCount++;
    } else if (op.kind === 'add') {
      newCount++;
    }
  }
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}

// Render a full unified diff with hunk markers. Colors are passed in (so
// the renderer stays I/O-free and respects NO_COLOR centrally).
function unifiedDiff(oldText, newText, label, C = emptyPalette()) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const ops = lcsDiff(oldLines, newLines);
  const hunks = buildHunks(ops);

  const out = [];
  out.push(`${C.bold}--- a/${label}${C.reset}`);
  out.push(`${C.bold}+++ b/${label}${C.reset}`);

  if (hunks.length === 0) return out.join('\n');

  for (const h of hunks) {
    // Compute old/new starting line numbers for this hunk by counting
    // the ops *before* the hunk.
    let oldLineNo = 1;
    let newLineNo = 1;
    for (let i = 0; i < h.from; i++) {
      const op = ops[i];
      if (op.kind === 'eq') {
        oldLineNo++;
        newLineNo++;
      } else if (op.kind === 'del') {
        oldLineNo++;
      } else if (op.kind === 'add') {
        newLineNo++;
      }
    }
    out.push(`${C.cyan}${hunkHeader(h.ops, oldLineNo, newLineNo)}${C.reset}`);
    for (const op of h.ops) {
      if (op.kind === 'eq') out.push(`${C.dim} ${op.line}${C.reset}`);
      else if (op.kind === 'del') out.push(`${C.red}-${op.line}${C.reset}`);
      else if (op.kind === 'add') out.push(`${C.green}+${op.line}${C.reset}`);
    }
  }
  return out.join('\n');
}

function emptyPalette() {
  return { red: '', green: '', cyan: '', dim: '', bold: '', reset: '' };
}

function differs(oldText, newText) {
  return oldText !== newText;
}

module.exports = { lcsDiff, buildHunks, unifiedDiff, differs };
