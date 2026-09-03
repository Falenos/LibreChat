'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  parseIsoDate,
  parsePendingRows,
  publishReleaseNotes,
  renderReleaseGroups,
  splitMarkdownRow,
} = require('./publish-release-notes');

const HELP_TEMPLATE = `<!doctype html>
<section id="en-release-notes">
  <!-- release-notes:en:begin -->
  <!-- release-notes:en:end -->
</section>
<section id="de-release-notes">
  <!-- release-notes:de:begin -->
  <!-- release-notes:de:end -->
</section>
`;

test('splitMarkdownRow preserves escaped pipes inside release-note copy', () => {
  assert.deepEqual(splitMarkdownRow('| 2026-09-03 | KK20-250 | Open A \\| B | Öffne A \\| B |'), [
    '2026-09-03',
    'KK20-250',
    'Open A | B',
    'Öffne A | B',
  ]);
});

test('parsePendingRows reads bilingual pending entries', () => {
  const markdown = `| Date | Ticket | English | German |
| --- | --- | --- | --- |
| 2026-09-03 | KK20-250 | Open release notes. | Versionshinweise öffnen. |
`;
  assert.deepEqual(parsePendingRows(markdown), [
    {
      date: '2026-09-03',
      ticket: 'KK20-250',
      en: 'Open release notes.',
      de: 'Versionshinweise öffnen.',
    },
  ]);
});

test('parsePendingRows rejects malformed table rows instead of silently skipping them', () => {
  const markdown = `| Date | Ticket | English | German |
| --- | --- | --- | --- |
| 2026/09/03 | KK20-250 | Open release notes. | Versionshinweise öffnen. |
`;
  assert.throws(() => parsePendingRows(markdown), /line 3 has invalid date 2026\/09\/03/);
});

test('parseIsoDate rejects impossible dates and accepts leap days', () => {
  assert.equal(parseIsoDate('2024-02-29').toISOString(), '2024-02-29T00:00:00.000Z');
  assert.throws(() => parseIsoDate('2026-02-30'), /Invalid date/);
  assert.throws(() => parseIsoDate('2026-13-01'), /Invalid date/);
});

test('publishReleaseNotes groups pending entries and clears only table data rows', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'karl-release-notes-'));
  const pendingPath = path.join(directory, 'unreleased.md');
  const publishedPath = path.join(directory, 'published.json');
  const helpPath = path.join(directory, 'index.html');
  fs.writeFileSync(
    pendingPath,
    `# Pending

| Date | Ticket | English | German |
| --- | --- | --- | --- |
| 2026-09-03 | KK20-250 | Open release notes. | Versionshinweise öffnen. |
`,
  );
  fs.writeFileSync(publishedPath, '{"groups":[]}\n');
  fs.writeFileSync(helpPath, HELP_TEMPLATE);

  const result = publishReleaseNotes({
    publicationDate: '2026-09-07',
    pendingPath,
    publishedPath,
    helpPath,
  });

  assert.deepEqual(result, { published: true, count: 1 });
  const published = JSON.parse(fs.readFileSync(publishedPath, 'utf8'));
  assert.equal(published.groups[0].date.en, 'September 7, 2026');
  assert.equal(published.groups[0].date.de, '7. September 2026');
  assert.equal(published.groups[0].items[0].ticket, 'KK20-250');
  assert.match(fs.readFileSync(helpPath, 'utf8'), /Open release notes\./);
  assert.doesNotMatch(fs.readFileSync(pendingPath, 'utf8'), /KK20-250/);
  assert.match(fs.readFileSync(pendingPath, 'utf8'), /\| Date \| Ticket \| English \| German \|/);
});

test('renderReleaseGroups expands eight groups and collapses the older archive', () => {
  const groups = Array.from({ length: 10 }, (_, index) => ({
    id: `group-${index}`,
    date: { en: `English ${index}`, de: `Deutsch ${index}` },
    items: [
      {
        id: `item-${index}`,
        ticket: `KK20-${index}`,
        date: '2026-09-01',
        en: `English item ${index}`,
        de: `Deutscher Eintrag ${index}`,
      },
    ],
  }));

  const html = renderReleaseGroups(groups, 'en');
  assert.equal((html.match(/<article class="release-group">/g) ?? []).length, 10);
  assert.equal((html.match(/<details class="release-archive">/g) ?? []).length, 1);
  assert.ok(html.indexOf('English 7') < html.indexOf('Earlier releases'));
  assert.ok(html.indexOf('Earlier releases') < html.indexOf('English 8'));
});

test('publishReleaseNotes deduplicates identical rows in one publication group', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'karl-release-notes-'));
  const pendingPath = path.join(directory, 'unreleased.md');
  const publishedPath = path.join(directory, 'published.json');
  const helpPath = path.join(directory, 'index.html');
  fs.writeFileSync(
    pendingPath,
    `| Date | Ticket | English | German |
| --- | --- | --- | --- |
| 2026-09-03 | KK20-250 | Open release notes. | Versionshinweise öffnen. |
| 2026-09-03 | KK20-250 | Open release notes. | Versionshinweise öffnen. |
`,
  );
  fs.writeFileSync(publishedPath, '{"groups":[]}\n');
  fs.writeFileSync(helpPath, HELP_TEMPLATE);

  publishReleaseNotes({
    publicationDate: '2026-09-07',
    pendingPath,
    publishedPath,
    helpPath,
  });

  const published = JSON.parse(fs.readFileSync(publishedPath, 'utf8'));
  assert.equal(published.groups[0].items.length, 1);
});
