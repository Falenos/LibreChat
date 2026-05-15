// @ts-check
//
// glob.js — hardened pattern matcher for SEAMS.md "Net-New Files" rows
//
// Supports:
//   `*`   — any chars except `/`
//   `**`  — any chars including `/`
//   `?`   — exactly one char except `/`
//   anything else is literal (regex metas are escaped)
//
// This is intentionally a small subset of minimatch — we don't need brace
// expansion, character classes, or negation for the SEAMS.md use case.

'use strict';

function compile(pattern) {
  // Walk the pattern, emitting regex source. We can't do a simple
  // replace-all because `**` must be detected before `*`.
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++; // consume second *
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  re += '$';
  return new RegExp(re);
}

const _cache = new Map();

function matches(pattern, file) {
  let re = _cache.get(pattern);
  if (!re) {
    re = compile(pattern);
    _cache.set(pattern, re);
  }
  return re.test(file);
}

// Checks whether a file path is "registered" in a list of Net-New Files
// rows. A row's `file` field can be either an exact path or a glob.
function isFileRegisteredInNewTable(file, rows) {
  const norm = file.replace(/\\/g, '/');
  for (const row of rows) {
    const pattern = row.file;
    // Cheap fast path: exact match without compiling a regex.
    if (pattern === norm) return true;
    // Only compile if the pattern actually contains a wildcard.
    if (pattern.includes('*') || pattern.includes('?')) {
      if (matches(pattern, norm)) return true;
    }
  }
  return false;
}

module.exports = { compile, matches, isFileRegisteredInNewTable };
