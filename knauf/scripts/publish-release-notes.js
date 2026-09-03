#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PENDING_PATH = path.join(
  REPO_ROOT,
  'knauf',
  'docs',
  'release-notes',
  'unreleased.md',
);
const DEFAULT_PUBLISHED_PATH = path.join(
  REPO_ROOT,
  'knauf',
  'docs',
  'release-notes',
  'published.json',
);
const DEFAULT_HELP_PATH = path.join(REPO_ROOT, 'client', 'public', 'help', 'index.html');
const RECENT_GROUP_LIMIT = 8;

function splitMarkdownRow(line) {
  const row = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cell = '';

  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === '\\' && row[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseIsoDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) {
    throw new Error(`Invalid date: ${isoDate}`);
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date: ${isoDate}`);
  }
  return date;
}

function parsePendingTable(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const cells = splitMarkdownRow(line);
    return (
      cells.length === 4 &&
      cells[0] === 'Date' &&
      cells[1] === 'Ticket' &&
      cells[2] === 'English' &&
      cells[3] === 'German'
    );
  });
  if (headerIndex === -1) {
    throw new Error('Pending release-note table header is missing');
  }
  const separator = splitMarkdownRow(lines[headerIndex + 1] ?? '');
  if (separator.length !== 4 || separator.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
    throw new Error('Pending release-note table separator is invalid');
  }

  const rows = [];
  const rowIndexes = [];
  for (let lineIndex = headerIndex + 2; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim().startsWith('|')) {
      break;
    }
    const cells = splitMarkdownRow(line);
    if (cells.length !== 4) {
      throw new Error(`Pending release-note line ${lineIndex + 1} must have four columns`);
    }
    const [date, ticket, en, de] = cells;
    try {
      parseIsoDate(date);
    } catch {
      throw new Error(`Pending release-note line ${lineIndex + 1} has invalid date ${date}`);
    }
    if (!ticket || !en || !de) {
      throw new Error(`Pending release-note line ${lineIndex + 1} has an empty field`);
    }
    rows.push({ date, ticket, en, de });
    rowIndexes.push(lineIndex);
  }
  return { lines, rows, rowIndexes };
}

function parsePendingRows(markdown) {
  return parsePendingTable(markdown).rows;
}

function clearPendingRows(markdown) {
  const { lines, rowIndexes } = parsePendingTable(markdown);
  const publishedIndexes = new Set(rowIndexes);
  return `${lines
    .filter((_, lineIndex) => !publishedIndexes.has(lineIndex))
    .join('\n')
    .trimEnd()}\n`;
}

function formatPublicationDate(isoDate, language) {
  const date = parseIsoDate(isoDate);
  return new Intl.DateTimeFormat(language === 'de' ? 'de-DE' : 'en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderGroup(group, language, indent) {
  const lines = [
    `${indent}<article class="release-group">`,
    `${indent}  <h3>${escapeHtml(group.date[language])}</h3>`,
    `${indent}  <ul>`,
  ];
  for (const item of group.items) {
    lines.push(`${indent}    <li>${escapeHtml(item[language])}</li>`);
  }
  lines.push(`${indent}  </ul>`, `${indent}</article>`);
  return lines.join('\n');
}

function renderReleaseGroups(groups, language) {
  const recent = groups.slice(0, RECENT_GROUP_LIMIT);
  const older = groups.slice(RECENT_GROUP_LIMIT);
  const blocks = recent.map((group) => renderGroup(group, language, '        '));

  if (older.length > 0) {
    const summary = language === 'de' ? 'Frühere Versionen' : 'Earlier releases';
    blocks.push(
      [
        '        <details class="release-archive">',
        `          <summary>${summary}</summary>`,
        '          <div class="release-archive-content">',
        ...older.map((group) => renderGroup(group, language, '            ')),
        '          </div>',
        '        </details>',
      ].join('\n'),
    );
  }

  return blocks.join('\n');
}

function replaceGeneratedSection(html, language, content) {
  const startMarker = `<!-- release-notes:${language}:begin -->`;
  const endMarker = `<!-- release-notes:${language}:end -->`;
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Missing or invalid ${language} release-note markers in help page`);
  }
  const contentStart = start + startMarker.length;
  return `${html.slice(0, contentStart)}\n${content}\n        ${html.slice(end)}`;
}

function renderHelpHtml(html, groups) {
  let rendered = replaceGeneratedSection(html, 'en', renderReleaseGroups(groups, 'en'));
  rendered = replaceGeneratedSection(rendered, 'de', renderReleaseGroups(groups, 'de'));
  return rendered;
}

function readPublished(filePath) {
  const published = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!published || !Array.isArray(published.groups)) {
    throw new Error('Published release-note data must contain a groups array');
  }
  return published;
}

function buildPublishedData(published, pendingRows, publicationDate) {
  const groupId = publicationDate;
  const existingGroup = published.groups.find((group) => group.id === groupId);
  const itemOffset = existingGroup?.items.length ?? 0;
  const items = pendingRows.map((row, index) => ({
    id: `${row.ticket.toLowerCase()}-${row.date}-${itemOffset + index + 1}`,
    ticket: row.ticket,
    date: row.date,
    en: row.en,
    de: row.de,
  }));
  const existingKeys = new Set(
    (existingGroup?.items ?? []).map((item) => `${item.ticket}\u0000${item.en}\u0000${item.de}`),
  );
  const uniqueItems = items.filter((item) => {
    const key = `${item.ticket}\u0000${item.en}\u0000${item.de}`;
    if (existingKeys.has(key)) {
      return false;
    }
    existingKeys.add(key);
    return true;
  });

  if (existingGroup) {
    existingGroup.items.push(...uniqueItems);
    return published;
  }

  published.groups.unshift({
    id: groupId,
    date: {
      en: formatPublicationDate(publicationDate, 'en'),
      de: formatPublicationDate(publicationDate, 'de'),
    },
    items: uniqueItems,
  });
  return published;
}

function publishReleaseNotes({
  publicationDate,
  pendingPath = DEFAULT_PENDING_PATH,
  publishedPath = DEFAULT_PUBLISHED_PATH,
  helpPath = DEFAULT_HELP_PATH,
}) {
  const pendingMarkdown = fs.readFileSync(pendingPath, 'utf8');
  const pendingRows = parsePendingRows(pendingMarkdown);
  if (pendingRows.length === 0) {
    return { published: false, count: 0 };
  }
  if (pendingRows.some((row) => row.date > publicationDate)) {
    throw new Error(`Pending release notes cannot be newer than ${publicationDate}`);
  }

  const published = buildPublishedData(readPublished(publishedPath), pendingRows, publicationDate);
  const helpHtml = fs.readFileSync(helpPath, 'utf8');
  const renderedHtml = renderHelpHtml(helpHtml, published.groups);

  fs.writeFileSync(publishedPath, `${JSON.stringify(published, null, 2)}\n`);
  fs.writeFileSync(helpPath, renderedHtml);
  fs.writeFileSync(pendingPath, clearPendingRows(pendingMarkdown));
  return { published: true, count: pendingRows.length };
}

function checkGeneratedHelp({
  publishedPath = DEFAULT_PUBLISHED_PATH,
  helpPath = DEFAULT_HELP_PATH,
} = {}) {
  const published = readPublished(publishedPath);
  const helpHtml = fs.readFileSync(helpPath, 'utf8');
  const expected = renderHelpHtml(helpHtml, published.groups);
  if (expected !== helpHtml) {
    throw new Error('Help release-note sections are not generated from published.json');
  }
}

function renderPublishedHelp({
  publishedPath = DEFAULT_PUBLISHED_PATH,
  helpPath = DEFAULT_HELP_PATH,
} = {}) {
  const published = readPublished(publishedPath);
  const helpHtml = fs.readFileSync(helpPath, 'utf8');
  fs.writeFileSync(helpPath, renderHelpHtml(helpHtml, published.groups));
}

function getArgument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value?.slice(prefix.length);
}

if (require.main === module) {
  try {
    if (process.argv.includes('--check')) {
      checkGeneratedHelp();
      console.log('KARL release-note HTML is synchronized with published.json.');
    } else if (process.argv.includes('--render')) {
      renderPublishedHelp();
      console.log('Rendered KARL release-note HTML from published.json.');
    } else {
      const publicationDate = getArgument('date') ?? new Date().toISOString().slice(0, 10);
      const result = publishReleaseNotes({ publicationDate });
      console.log(
        result.published
          ? `Published ${result.count} pending KARL release-note entries.`
          : 'No pending KARL release-note entries to publish.',
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

module.exports = {
  RECENT_GROUP_LIMIT,
  buildPublishedData,
  checkGeneratedHelp,
  clearPendingRows,
  formatPublicationDate,
  parseIsoDate,
  parsePendingRows,
  publishReleaseNotes,
  renderHelpHtml,
  renderPublishedHelp,
  renderReleaseGroups,
  splitMarkdownRow,
};
