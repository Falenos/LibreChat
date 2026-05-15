// @ts-check
//
// manifest.js — read, parse, and render SEAMS.md
//
// SEAMS.md has two auto-managed regions:
//   • Inline Modifications — `<!-- seams:auto:begin --> ... <!-- seams:auto:end -->`
//   • Net-New Files        — `<!-- seams:new:begin --> ... <!-- seams:new:end -->`
//
// Both regions hold markdown tables. The first column ("File") is the key;
// the rest is human-curated content that the tool preserves on rewrite.

'use strict';

const fs = require('fs');

const SENTINEL_BEGIN = '<!-- seams:auto:begin -->';
const SENTINEL_END = '<!-- seams:auto:end -->';
const SENTINEL_NEW_BEGIN = '<!-- seams:new:begin -->';
const SENTINEL_NEW_END = '<!-- seams:new:end -->';

const PLACEHOLDER = '—';

// ---------- read ----------

function readSeamsMd(seamsPath, onFail) {
  if (!fs.existsSync(seamsPath)) onFail(`SEAMS.md not found at ${seamsPath}`);
  return fs.readFileSync(seamsPath, 'utf8');
}

// ---------- split into auto-managed regions ----------

function splitAutoBlock(md) {
  const ib = md.indexOf(SENTINEL_BEGIN);
  const ie = md.indexOf(SENTINEL_END);
  if (ib === -1 || ie === -1 || ie < ib) {
    return { before: md, autoBlock: null, after: '' };
  }
  return {
    before: md.slice(0, ib + SENTINEL_BEGIN.length),
    autoBlock: md.slice(ib + SENTINEL_BEGIN.length, ie),
    after: md.slice(ie),
  };
}

function splitNewBlock(md) {
  const ib = md.indexOf(SENTINEL_NEW_BEGIN);
  const ie = md.indexOf(SENTINEL_NEW_END);
  if (ib === -1 || ie === -1 || ie < ib) {
    return { before: md, newBlock: null, after: '' };
  }
  return {
    before: md.slice(0, ib + SENTINEL_NEW_BEGIN.length),
    newBlock: md.slice(ib + SENTINEL_NEW_BEGIN.length, ie),
    after: md.slice(ie),
  };
}

// ---------- parse rows from a block ----------

function splitTableCells(line) {
  const inner = line.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim());
}

function stripBackticks(s) {
  return s.replace(/^`/, '').replace(/`$/, '').trim();
}

// Strict parser. A line that starts with `|` and isn't a header or separator
// IS attempting to be a data row. Wrong column count or empty File cell ⇒
// throw. Silent-skip was a tripwire: a malformed hand-edit would parse to
// zero rows, and the next `write` would treat every actual seam as new,
// destroying the human-curated columns.
function parseAutoBlockRows(autoBlock) {
  if (!autoBlock) return [];
  const rows = [];
  const blockLines = autoBlock.split('\n');
  for (let i = 0; i < blockLines.length; i++) {
    const line = blockLines[i].trim();
    if (!line.startsWith('|')) continue;
    if (/^\|\s*-+\s*\|/.test(line)) continue;
    if (/^\|\s*File\s*\|/.test(line)) continue;
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

function parseNewFileRows(newBlock) {
  if (!newBlock) return [];
  const rows = [];
  const blockLines = newBlock.split('\n');
  for (let i = 0; i < blockLines.length; i++) {
    const line = blockLines[i].trim();
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

// ---------- render tables ----------

function renderTable(rows) {
  const header = '| File | Symbol/Anchor | Lines | Purpose | Tests |\n|---|---|---|---|---|';
  if (rows.length === 0) return `\n${header}\n`;
  const body = rows
    .map((r) => {
      const file = '`' + r.file + '`';
      return `| ${file} | ${r.symbol || PLACEHOLDER} | ${r.lines || PLACEHOLDER} | ${r.purpose || PLACEHOLDER} | ${r.tests || PLACEHOLDER} |`;
    })
    .join('\n');
  return `\n${header}\n${body}\n`;
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

module.exports = {
  SENTINEL_BEGIN,
  SENTINEL_END,
  SENTINEL_NEW_BEGIN,
  SENTINEL_NEW_END,
  PLACEHOLDER,
  readSeamsMd,
  splitAutoBlock,
  splitNewBlock,
  splitTableCells,
  stripBackticks,
  parseAutoBlockRows,
  parseNewFileRows,
  renderTable,
  renderNewFilesTable,
};
