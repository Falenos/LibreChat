// @ts-check
//
// merge.js — combine existing manifest rows with newly-discovered seams
//
// The central design rule:
//   • `Lines` is auto-managed (always overwritten by discovery)
//   • `Symbol/Anchor`, `Purpose`, `Tests` are human-curated (never overwritten)
//   • A row whose file lost its markers is dropped — surfaced as `removed`
//   • A newly-discovered file becomes a row with a placeholder description

'use strict';

const { PLACEHOLDER } = require('./manifest.js');

// Collapse multiple seams in the same file into one row.
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
    const purpose = (list.find((s) => s.description) || {}).description || PLACEHOLDER;
    rows.push({ file, lines: ranges, purpose });
  }
  return rows;
}

// Group/sort priority for new rows (mirrors the existing SEAMS.md convention).
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

function mergeRows(existing, discovered) {
  const discoveredByFile = new Map(discovered.map((r) => [r.file, r]));
  const existingByFile = new Map(existing.map((r) => [r.file, r]));

  // Pass 1: keep rows whose file still has markers; update only Lines.
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

  // Pass 2: append rows for newly-discovered files. Pre-fill Purpose with the
  // first marker's description as a starting point for the human author.
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

function mergeNewFileRows(existing, added) {
  const existingByFile = new Map(existing.map((r) => [r.file, r]));
  const newRows = added
    .filter((f) => !existingByFile.has(f))
    .map((f) => ({ file: f, imports: PLACEHOLDER, risk: PLACEHOLDER, tests: PLACEHOLDER }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return [...existing, ...newRows];
}

module.exports = { aggregateRows, rowGroup, compareNewRows, mergeRows, mergeNewFileRows };
