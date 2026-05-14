// Unit tests for knauf/scripts/seams.js
//
// Uses Node's built-in test runner (node:test, stable since Node 18) to avoid
// pulling Jest into a script whose selling point is zero deps. Run with:
//   node --test knauf/scripts/seams.spec.js
// or: npm run test:seams
//
// Covered: classifyFile, parseArgv, scanFile, cleanDescription, aggregateRows,
// mergeRows, splitAutoBlock, splitNewBlock, parseAutoBlockRows, splitTableCells,
// isFileRegisteredInNewTable, mergeNewFileRows, renderTable, lcsDiff, buildNewMd.
//
// Not covered (intentional): git/spawnSync wrappers, file-system walk, prompt I/O,
// CLI dispatch. Those are integration concerns and would require a fixture repo.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const seams = require('./seams.js');

// ---------------- classifyFile ----------------

test('classifyFile · upstream prefixes', () => {
  assert.equal(seams.classifyFile('api/server/index.js'), 'upstream');
  assert.equal(seams.classifyFile('client/src/components/App.tsx'), 'upstream');
  assert.equal(seams.classifyFile('packages/api/src/foo.ts'), 'upstream');
  assert.equal(seams.classifyFile('packages/data-provider/src/config.ts'), 'upstream');
});

test('classifyFile · root Dockerfiles are upstream', () => {
  assert.equal(seams.classifyFile('Dockerfile'), 'upstream');
  assert.equal(seams.classifyFile('Dockerfile.multi'), 'upstream');
  assert.equal(seams.classifyFile('Dockerfile.dev'), 'upstream');
});

test('classifyFile · knauf-only directories', () => {
  assert.equal(seams.classifyFile('api/server/routes/knauf/index.js'), 'knauf-only');
  assert.equal(seams.classifyFile('client/src/knauf/components/Foo.tsx'), 'knauf-only');
  assert.equal(seams.classifyFile('packages/knauf/src/foo.ts'), 'knauf-only');
});

test('classifyFile · top-level knauf/ is meta (tooling, not runtime)', () => {
  assert.equal(seams.classifyFile('knauf/scripts/seams.js'), 'meta');
  assert.equal(seams.classifyFile('knauf/docs/foo.md'), 'meta');
});

test('classifyFile · config files', () => {
  assert.equal(seams.classifyFile('librechat.yaml'), 'config');
  assert.equal(seams.classifyFile('docker-compose.override.yml'), 'config');
  assert.equal(seams.classifyFile('.env'), 'config');
  assert.equal(seams.classifyFile('.env.local'), 'config');
});

test('classifyFile · meta paths', () => {
  assert.equal(seams.classifyFile('.github/workflows/test.yml'), 'meta');
  assert.equal(seams.classifyFile('.husky/pre-commit'), 'meta');
  assert.equal(seams.classifyFile('README.md'), 'meta');
  assert.equal(seams.classifyFile('CLAUDE.md'), 'meta');
  assert.equal(seams.classifyFile('package-lock.json'), 'meta');
  assert.equal(seams.classifyFile('package.json'), 'meta');
  assert.equal(seams.classifyFile('turbo.json'), 'meta');
});

test('classifyFile · ignore paths', () => {
  assert.equal(seams.classifyFile('node_modules/foo/bar.js'), 'ignore');
  assert.equal(seams.classifyFile('client/node_modules/foo/bar.js'), 'ignore');
  assert.equal(seams.classifyFile('dist/main.js'), 'ignore');
  assert.equal(seams.classifyFile('.git/HEAD'), 'ignore');
});

test('classifyFile · Windows backslashes are normalized', () => {
  assert.equal(seams.classifyFile('api\\server\\index.js'), 'upstream');
  assert.equal(seams.classifyFile('client\\src\\knauf\\foo.tsx'), 'knauf-only');
});

// ---------------- parseArgv ----------------

test('parseArgv · empty argv', () => {
  const r = seams.parseArgv([]);
  assert.deepEqual(r._, []);
  // util.parseArgs returns a null-prototype object; check emptiness via keys
  // instead of structural equality with `{}`.
  assert.equal(Object.keys(r.flags).length, 0);
});

test('parseArgv · positional command', () => {
  const r = seams.parseArgv(['scan']);
  assert.deepEqual(r._, ['scan']);
});

test('parseArgv · boolean flags', () => {
  const r = seams.parseArgv(['scan', '--diff', '--json']);
  assert.equal(r.flags.diff, true);
  assert.equal(r.flags.json, true);
});

test('parseArgv · --flag=value form', () => {
  const r = seams.parseArgv(['scan', '--base=abc123']);
  assert.equal(r.flags.base, 'abc123');
});

test('parseArgv · --flag value form (space-separated)', () => {
  const r = seams.parseArgv(['scan', '--base', 'abc123']);
  assert.equal(r.flags.base, 'abc123');
});

// ---------------- cleanDescription ----------------

test('cleanDescription · strips only the comment-close shell, preserves content', () => {
  // /* ... */ close
  assert.equal(
    seams.cleanDescription('Mount-point — Knauf router */'),
    'Mount-point — Knauf router',
  );
  // {/* ... */} close (JSX)
  assert.equal(seams.cleanDescription('KNAUF_HIDE_ADVANCED */}'), 'KNAUF_HIDE_ADVANCED');
  // HTML close
  assert.equal(seams.cleanDescription('embed librechat.yaml -->'), 'embed librechat.yaml');
  // No close — passthrough (only trim whitespace)
  assert.equal(seams.cleanDescription('  Hide the advanced panel  '), 'Hide the advanced panel');
});

test('cleanDescription · preserves leading punctuation (em-dash, colon)', () => {
  // Authors legitimately write `// [knauf] — Tier 5 fork seam`. The leading
  // em-dash is content, not comment scaffolding — keep it.
  assert.equal(seams.cleanDescription('— Tier 5 fork seam'), '— Tier 5 fork seam');
  assert.equal(seams.cleanDescription(': handles edge case */'), ': handles edge case');
});

test('cleanDescription · empty input returns empty string', () => {
  assert.equal(seams.cleanDescription(''), '');
  assert.equal(seams.cleanDescription(undefined), '');
});

// ---------------- scanFile ----------------

function withTempFile(name, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seams-spec-'));
  const repoRel = path.join(dir, name);
  fs.mkdirSync(path.dirname(repoRel), { recursive: true });
  fs.writeFileSync(repoRel, content, 'utf8');
  // scanFile expects a path relative to REPO_ROOT. Since we can't easily
  // redirect REPO_ROOT, we read the file directly with the same regex
  // logic. Instead, write the file *inside* the repo under a known fixture
  // location and read it relative.
  return { dir, repoRel, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// scanFile is REPO_ROOT-relative — easier to drive it with real fixture
// files placed inside the actual repo's fixtures directory.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'knauf', 'scripts', '__fixtures__');

function writeFixture(rel, content) {
  const abs = path.join(FIXTURE_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
}

test('scanFile · paired // [knauf] / End [knauf] block', () => {
  const rel = writeFixture(
    'scan-paired.tsx',
    [
      'const x = 1;',
      '// [knauf] Hide the advanced panel button',
      'const hidden = true;',
      '// End [knauf]',
      'const y = 2;',
    ].join('\n'),
  );
  const r = seams.scanFile(rel);
  assert.equal(r.missing, false);
  assert.equal(r.seams.length, 1);
  assert.equal(r.seams[0].startLine, 2);
  assert.equal(r.seams[0].endLine, 4);
  assert.match(r.seams[0].description, /Hide the advanced panel/);
  assert.equal(r.unpaired.length, 0);
});

test('scanFile · unpaired open emits warning', () => {
  const rel = writeFixture(
    'scan-unpaired-open.js',
    ['const a = 1;', '// [knauf] Forgot to close', 'const b = 2;'].join('\n'),
  );
  const r = seams.scanFile(rel);
  assert.equal(r.seams.length, 0);
  assert.equal(r.unpaired.length, 1);
  assert.equal(r.unpaired[0].kind, 'open-without-close');
  assert.equal(r.unpaired[0].line, 2);
});

test('scanFile · unpaired close emits warning', () => {
  const rel = writeFixture('scan-unpaired-close.js', ['const a = 1;', '// End [knauf]'].join('\n'));
  const r = seams.scanFile(rel);
  assert.equal(r.unpaired.length, 1);
  assert.equal(r.unpaired[0].kind, 'close-without-open');
});

test('scanFile · Dockerfile # comments are recognized', () => {
  const rel = writeFixture(
    'scan-dockerfile.Dockerfile',
    [
      'FROM alpine',
      '# [knauf] Copy librechat.yaml',
      'COPY librechat.yaml /app/',
      '# End [knauf]',
    ].join('\n'),
  );
  const r = seams.scanFile(rel);
  assert.equal(r.seams.length, 1);
  assert.equal(r.seams[0].startLine, 2);
  assert.equal(r.seams[0].endLine, 4);
});

test('scanFile · multiple blocks in one file', () => {
  const rel = writeFixture(
    'scan-multi.tsx',
    [
      '// [knauf] First block',
      'const a = 1;',
      '// End [knauf]',
      'const b = 2;',
      '// [knauf] Second block',
      'const c = 3;',
      '// End [knauf]',
    ].join('\n'),
  );
  const r = seams.scanFile(rel);
  assert.equal(r.seams.length, 2);
  assert.equal(r.seams[0].startLine, 1);
  assert.equal(r.seams[1].startLine, 5);
});

test('scanFile · missing file returns missing=true', () => {
  const r = seams.scanFile('this/does/not/exist.js');
  assert.equal(r.missing, true);
  assert.deepEqual(r.seams, []);
});

// ---------------- H2: per-extension comment tokens & near-miss detection ---

test('scanFile · # comments do NOT match in .tsx (wrong syntax for the file)', () => {
  const rel = writeFixture(
    'scan-wrong-syntax.tsx',
    [
      '# [knauf] this is a YAML-style comment, not valid in JSX',
      'const a = 1;',
      '# End [knauf]',
    ].join('\n'),
  );
  const r = seams.scanFile(rel);
  // The # marker is not valid JS/TSX syntax — should be ignored entirely,
  // not flagged as malformed or paired.
  assert.equal(r.seams.length, 0);
  assert.equal(r.unpaired.length, 0);
});

test('scanFile · // comments do NOT match in Dockerfile (wrong syntax)', () => {
  // The fixture must be named `Dockerfile` (or Dockerfile.<suffix>) for the
  // basename to match DOCKERFILE_RE — extension-style `.Dockerfile` doesn't.
  const rel = writeFixture(
    'Dockerfile.scantest',
    [
      'FROM alpine',
      '// [knauf] not valid Dockerfile syntax',
      'COPY foo /app',
      '// End [knauf]',
    ].join('\n'),
  );
  const r = seams.scanFile(rel);
  assert.equal(r.seams.length, 0);
});

test('scanFile · flags near-miss [Knauf] (wrong case)', () => {
  const rel = writeFixture(
    'scan-wrong-case.tsx',
    ['const a = 1;', '// [Knauf] mixed case — should warn', 'const b = 2;'].join('\n'),
  );
  const r = seams.scanFile(rel);
  assert.equal(r.seams.length, 0);
  assert.equal(r.unpaired.length, 1);
  assert.equal(r.unpaired[0].kind, 'malformed-marker');
});

test('scanFile · flags near-miss [ knauf ] (whitespace inside brackets)', () => {
  const rel = writeFixture(
    'scan-inner-space.tsx',
    ['// [ knauf ] inner whitespace — should warn'].join('\n'),
  );
  const r = seams.scanFile(rel);
  assert.equal(r.unpaired.length, 1);
  assert.equal(r.unpaired[0].kind, 'malformed-marker');
});

test('scanFile · canonical [knauf] does NOT trigger malformed-marker', () => {
  const rel = writeFixture(
    'scan-canonical.tsx',
    ['// [knauf] canonical form', 'const a = 1;', '// End [knauf]'].join('\n'),
  );
  const r = seams.scanFile(rel);
  assert.equal(r.seams.length, 1);
  assert.equal(r.unpaired.filter((u) => u.kind === 'malformed-marker').length, 0);
});

test('scanFile · flags nested open', () => {
  const rel = writeFixture(
    'scan-nested.tsx',
    [
      '// [knauf] outer',
      'const a = 1;',
      '// [knauf] inner — illegal nesting',
      'const b = 2;',
      '// End [knauf]',
    ].join('\n'),
  );
  const r = seams.scanFile(rel);
  const nested = r.unpaired.filter((u) => u.kind === 'nested-open');
  assert.equal(nested.length, 1);
  assert.equal(nested[0].line, 3);
  assert.equal(nested[0].openedAt, 1);
});

test('scanFile · JSX {/* [knauf] */} block matches', () => {
  const rel = writeFixture(
    'scan-jsx-block.tsx',
    [
      'function X() {',
      '  {/* [knauf] inside JSX */}',
      '  const a = 1;',
      '  {/* End [knauf] */}',
      '}',
    ].join('\n'),
  );
  const r = seams.scanFile(rel);
  assert.equal(r.seams.length, 1);
  assert.equal(r.seams[0].startLine, 2);
});

// ---------------- H3: strict row-shape validation -------------------------

test('parseAutoBlockRows · throws on row with wrong column count', () => {
  const block = [
    '',
    '| File | Symbol/Anchor | Lines | Purpose | Tests |',
    '|---|---|---|---|---|',
    '| `a.tsx` | `A` | only-three | columns |', // 4 cells, not 5
    '',
  ].join('\n');
  assert.throws(
    () => seams.parseAutoBlockRows(block),
    /Inline Modifications.*has 4 cell\(s\), expected 5/,
  );
});

test('parseAutoBlockRows · throws on empty File cell', () => {
  const block = [
    '| File | Symbol/Anchor | Lines | Purpose | Tests |',
    '|---|---|---|---|---|',
    '|  | `X` | 1–2 | p | t |',
  ].join('\n');
  assert.throws(() => seams.parseAutoBlockRows(block), /empty File cell/);
});

test('parseNewFileRows · throws on row with wrong column count', () => {
  const block = [
    '| File | Upstream Imports | Coupling Risk | Tests |',
    '|---|---|---|---|',
    '| `a.ts` | imp | risk |', // 3 cells, not 4
  ].join('\n');
  assert.throws(() => seams.parseNewFileRows(block), /Net-New Files.*has 3 cell\(s\), expected 4/);
});

// ---------------- aggregateRows ----------------

test('aggregateRows · collapses multiple seams in same file into one row', () => {
  const seamsInput = [
    { file: 'a.tsx', startLine: 10, endLine: 12, description: 'first' },
    { file: 'a.tsx', startLine: 20, endLine: 25, description: 'second' },
    { file: 'b.tsx', startLine: 5, endLine: 7, description: 'only' },
  ];
  const rows = seams.aggregateRows(seamsInput);
  assert.equal(rows.length, 2);
  const a = rows.find((r) => r.file === 'a.tsx');
  assert.equal(a.lines, '10–12, 20–25');
  assert.equal(a.purpose, 'first'); // first non-empty description wins
});

test('aggregateRows · empty input returns empty array', () => {
  assert.deepEqual(seams.aggregateRows([]), []);
});

// ---------------- mergeRows ----------------

test('mergeRows · preserves human-curated Purpose/Symbol/Tests, updates Lines only', () => {
  const existing = [
    {
      file: 'a.tsx',
      symbol: '`MyComp`',
      lines: '10–12',
      purpose: 'human-written purpose',
      tests: 'a.spec.tsx',
    },
  ];
  const discovered = [{ file: 'a.tsx', lines: '50–55', purpose: 'discovered purpose' }];
  const merged = seams.mergeRows(existing, discovered);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].lines, '50–55'); // updated
  assert.equal(merged[0].purpose, 'human-written purpose'); // preserved
  assert.equal(merged[0].symbol, '`MyComp`'); // preserved
  assert.equal(merged[0].tests, 'a.spec.tsx'); // preserved
});

test('mergeRows · drops rows whose file no longer has markers', () => {
  const existing = [
    { file: 'gone.tsx', symbol: '`X`', lines: '1–2', purpose: 'p', tests: 't' },
    { file: 'kept.tsx', symbol: '`Y`', lines: '3–4', purpose: 'p', tests: 't' },
  ];
  const discovered = [{ file: 'kept.tsx', lines: '3–4', purpose: 'p' }];
  const merged = seams.mergeRows(existing, discovered);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].file, 'kept.tsx');
});

test('mergeRows · appends newly-discovered files at the end', () => {
  const existing = [{ file: 'a.tsx', symbol: '`A`', lines: '1–2', purpose: 'pa', tests: 'ta' }];
  const discovered = [
    { file: 'a.tsx', lines: '1–2', purpose: 'pa' },
    { file: 'api/server/new.js', lines: '5–7', purpose: 'fresh' },
  ];
  const merged = seams.mergeRows(existing, discovered);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].file, 'api/server/new.js');
  assert.equal(merged[1].purpose, 'fresh');
});

// ---------------- splitAutoBlock / splitNewBlock ----------------

test('splitAutoBlock · returns null autoBlock when sentinels missing', () => {
  const r = seams.splitAutoBlock('# title\n\nno sentinels here\n');
  assert.equal(r.autoBlock, null);
});

test('splitAutoBlock · captures content between sentinels exactly', () => {
  const md = [
    '# title',
    '',
    '<!-- seams:auto:begin -->',
    '| File | Symbol | Lines | Purpose | Tests |',
    '|---|---|---|---|---|',
    '| `a.tsx` | `A` | 1–2 | p | t |',
    '<!-- seams:auto:end -->',
    '',
    '## next section',
  ].join('\n');
  const r = seams.splitAutoBlock(md);
  assert.notEqual(r.autoBlock, null);
  assert.match(r.autoBlock, /a\.tsx/);
  assert.match(r.before, /seams:auto:begin -->$/);
  assert.match(r.after, /^<!-- seams:auto:end/);
});

test('parseAutoBlockRows · skips header and separator rows', () => {
  const block = [
    '',
    '| File | Symbol/Anchor | Lines | Purpose | Tests |',
    '|---|---|---|---|---|',
    '| `a.tsx` | `A` | 1–2 | purpose-a | test-a |',
    '| `b.tsx` | `B` | 3–4 | purpose-b | test-b |',
    '',
  ].join('\n');
  const rows = seams.parseAutoBlockRows(block);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].file, 'a.tsx');
  assert.equal(rows[0].symbol, '`A`');
  assert.equal(rows[1].file, 'b.tsx');
});

test('parseAutoBlockRows · null input returns empty array', () => {
  assert.deepEqual(seams.parseAutoBlockRows(null), []);
});

// ---------------- splitTableCells ----------------

test('splitTableCells · simple row', () => {
  const cells = seams.splitTableCells('| a | b | c |');
  assert.deepEqual(cells, ['a', 'b', 'c']);
});

test('splitTableCells · trims cells', () => {
  const cells = seams.splitTableCells('|   x   |   y   |');
  assert.deepEqual(cells, ['x', 'y']);
});

// ---------------- isFileRegisteredInNewTable ----------------

test('isFileRegisteredInNewTable · exact path match', () => {
  const rows = [{ file: 'client/src/knauf/components/Foo.tsx' }];
  assert.equal(seams.isFileRegisteredInNewTable('client/src/knauf/components/Foo.tsx', rows), true);
  assert.equal(
    seams.isFileRegisteredInNewTable('client/src/knauf/components/Bar.tsx', rows),
    false,
  );
});

test('isFileRegisteredInNewTable · single-star wildcard respects slash boundary', () => {
  const rows = [{ file: 'client/src/knauf/components/Agents/*.tsx' }];
  assert.equal(
    seams.isFileRegisteredInNewTable('client/src/knauf/components/Agents/Anything.tsx', rows),
    true,
  );
  // `*` is "no slashes" — nested directories must NOT match.
  assert.equal(
    seams.isFileRegisteredInNewTable('client/src/knauf/components/Agents/Sub/Deep.tsx', rows),
    false,
  );
  assert.equal(
    seams.isFileRegisteredInNewTable('client/src/knauf/components/Agents/Anything.ts', rows),
    false,
  );
});

test('isFileRegisteredInNewTable · double-star wildcard crosses slashes', () => {
  const rows = [{ file: 'client/src/knauf/**/*.tsx' }];
  assert.equal(seams.isFileRegisteredInNewTable('client/src/knauf/components/Foo.tsx', rows), true);
  assert.equal(
    seams.isFileRegisteredInNewTable('client/src/knauf/components/sub/deep/Bar.tsx', rows),
    true,
  );
});

test('isFileRegisteredInNewTable · regex metas in path are escaped', () => {
  // A literal `.` in a pattern must NOT match any character.
  const rows = [{ file: 'client/src/knauf/foo.bar.ts' }];
  assert.equal(seams.isFileRegisteredInNewTable('client/src/knauf/foo.bar.ts', rows), true);
  assert.equal(seams.isFileRegisteredInNewTable('client/src/knauf/fooxbarxts', rows), false);
});

// ---------------- mergeNewFileRows ----------------

test('mergeNewFileRows · appends unregistered added files', () => {
  const existing = [{ file: 'a.ts', imports: 'x', risk: 'Low', tests: 'Self' }];
  const added = ['a.ts', 'b.ts'];
  const merged = seams.mergeNewFileRows(existing, added);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].file, 'b.ts');
  assert.equal(merged[1].imports, '—');
});

// ---------------- renderTable ----------------

test('renderTable · renders header even when no rows', () => {
  const out = seams.renderTable([]);
  assert.match(out, /\| File \| Symbol\/Anchor \| Lines \| Purpose \| Tests \|/);
});

test('renderTable · backticks the file path', () => {
  const out = seams.renderTable([
    { file: 'a.tsx', symbol: 'X', lines: '1–2', purpose: 'p', tests: 't' },
  ]);
  assert.match(out, /\| `a\.tsx` \| X \| 1–2 \| p \| t \|/);
});

// ---------------- lcsDiff ----------------

test('lcsDiff · empty inputs', () => {
  assert.deepEqual(seams.lcsDiff([], []), []);
});

test('lcsDiff · pure addition', () => {
  const ops = seams.lcsDiff([], ['a', 'b']);
  assert.equal(ops.length, 2);
  assert.equal(
    ops.every((o) => o.kind === 'add'),
    true,
  );
});

test('lcsDiff · pure deletion', () => {
  const ops = seams.lcsDiff(['a', 'b'], []);
  assert.equal(
    ops.every((o) => o.kind === 'del'),
    true,
  );
});

test('lcsDiff · single replacement in the middle', () => {
  const ops = seams.lcsDiff(['a', 'b', 'c'], ['a', 'X', 'c']);
  const kinds = ops.map((o) => o.kind);
  assert.ok(kinds.includes('eq'));
  assert.ok(kinds.includes('del'));
  assert.ok(kinds.includes('add'));
});

// ---------------- buildNewMd (integration of merge + render) ----------------

test('buildNewMd · idempotent when discovered seams already match the manifest', () => {
  // renderTable produces `\n${header}\n${body}\n` between the sentinels, with
  // no blank lines. The fixture must match that exactly for idempotency.
  const md = [
    '<!-- seams:auto:begin -->',
    '| File | Symbol/Anchor | Lines | Purpose | Tests |',
    '|---|---|---|---|---|',
    '| `api/server/index.js` | `app.use` | 189–191 | Mount point | `spec.js` |',
    '<!-- seams:auto:end -->',
  ].join('\n');
  const discovered = [
    { file: 'api/server/index.js', startLine: 189, endLine: 191, description: 'Mount point' },
  ];
  const r = seams.buildNewMd(md, discovered, []);
  // Lines column matches → manifest unchanged.
  assert.equal(r.oldMd, r.newMd);
});

test('buildNewMd · reports removed rows when a file lost its markers', () => {
  // Manifest has two rows; we discover only one — the other should be flagged.
  const md = [
    '<!-- seams:auto:begin -->',
    '| File | Symbol/Anchor | Lines | Purpose | Tests |',
    '|---|---|---|---|---|',
    '| `kept.tsx` | `K` | 1–2 | p | t |',
    '| `gone.tsx` | `G` | 5–7 | p | t |',
    '<!-- seams:auto:end -->',
  ].join('\n');
  const discovered = [{ file: 'kept.tsx', startLine: 1, endLine: 2, description: 'p' }];
  const r = seams.buildNewMd(md, discovered, []);
  assert.equal(r.removedRows.length, 1);
  assert.equal(r.removedRows[0].file, 'gone.tsx');
});

test('buildNewMd · detects drift when discovered lines differ', () => {
  const md = [
    '<!-- seams:auto:begin -->',
    '',
    '| File | Symbol/Anchor | Lines | Purpose | Tests |',
    '|---|---|---|---|---|',
    '| `api/server/index.js` | `app.use` | 189–191 | Mount point | `spec.js` |',
    '',
    '<!-- seams:auto:end -->',
  ].join('\n');
  const discovered = [
    { file: 'api/server/index.js', startLine: 200, endLine: 202, description: 'Mount point' },
  ];
  const r = seams.buildNewMd(md, discovered, []);
  assert.notEqual(r.oldMd, r.newMd);
  assert.match(r.newMd, /200–202/);
});

// ---------------- lib/ direct-import smoke tests ------------------------
// These confirm each module in lib/ can be required independently and
// exposes its public surface. The bulk of the assertions live in the
// re-export-driven tests above; these only guard against accidental
// internal-only exports or circular-import breakage.

test('lib/classify · loads with classifyFile + isSourceFile', () => {
  const m = require('./lib/classify.js');
  assert.equal(typeof m.classifyFile, 'function');
  assert.equal(typeof m.isSourceFile, 'function');
  assert.equal(m.classifyFile('api/server/index.js'), 'upstream');
});

test('lib/glob · compile + matches handle ** correctly', () => {
  const { matches, compile } = require('./lib/glob.js');
  assert.equal(typeof compile, 'function');
  assert.equal(matches('a/**/b.ts', 'a/x/y/b.ts'), true);
  assert.equal(matches('a/*.ts', 'a/b.ts'), true);
  assert.equal(matches('a/*.ts', 'a/sub/b.ts'), false);
});

test('lib/diff · buildHunks produces hunks only around changes', () => {
  const { lcsDiff, buildHunks } = require('./lib/diff.js');
  const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const b = ['1', '2', '3', '4', 'X', '6', '7', '8', '9'];
  const ops = lcsDiff(a, b);
  const hunks = buildHunks(ops);
  assert.equal(hunks.length, 1);
  // Hunk should contain the change plus 3 lines of context on each side.
  const kinds = hunks[0].ops.map((o) => o.kind);
  assert.ok(kinds.includes('del'));
  assert.ok(kinds.includes('add'));
});

test('lib/diff · unifiedDiff emits @@ hunk header', () => {
  const { unifiedDiff } = require('./lib/diff.js');
  const out = unifiedDiff('a\nb\nc\n', 'a\nX\nc\n', 'fixture');
  assert.match(out, /^--- a\/fixture/m);
  assert.match(out, /^\+\+\+ b\/fixture/m);
  assert.match(out, /^@@ -\d+,\d+ \+\d+,\d+ @@/m);
});

test('lib/manifest · readSeamsMd is a function', () => {
  const m = require('./lib/manifest.js');
  assert.equal(typeof m.readSeamsMd, 'function');
  assert.equal(typeof m.splitAutoBlock, 'function');
  assert.equal(typeof m.PLACEHOLDER, 'string');
});

test('lib/merge · aggregateRows + mergeRows are pure', () => {
  const { aggregateRows, mergeRows } = require('./lib/merge.js');
  const agg = aggregateRows([{ file: 'a.tsx', startLine: 1, endLine: 2, description: 'd' }]);
  assert.equal(agg.length, 1);
  assert.equal(agg[0].lines, '1–2');
  const merged = mergeRows([], agg);
  assert.equal(merged.length, 1);
});

test('lib/io · makePalette returns the expected keys', () => {
  const { makePalette } = require('./lib/io.js');
  const p = makePalette();
  for (const k of ['red', 'green', 'yellow', 'cyan', 'dim', 'bold', 'reset']) {
    assert.ok(k in p, `palette missing ${k}`);
  }
});

test('lib/git · makeGit factory returns the expected surface', () => {
  const { makeGit } = require('./lib/git.js');
  const g = makeGit(process.cwd());
  for (const k of [
    'git',
    'resolveDefaultBranch',
    'resolveDiffBase',
    'changedFiles',
    'addedFiles',
  ]) {
    assert.equal(typeof g[k], 'function', `makeGit missing ${k}`);
  }
});

test('lib/walk · makeWalker factory returns walkAll', () => {
  const { makeWalker } = require('./lib/walk.js');
  const w = makeWalker(process.cwd());
  assert.equal(typeof w.walkAll, 'function');
});

test('lib/scan · makeScanner factory returns scanFile + fileHasMarker', () => {
  const { makeScanner } = require('./lib/scan.js');
  const s = makeScanner(process.cwd());
  assert.equal(typeof s.scanFile, 'function');
  assert.equal(typeof s.fileHasMarker, 'function');
});

test('seams.config · exposes the documented schema', () => {
  const cfg = require('./seams.config.js');
  for (const k of [
    'knaufDirs',
    'configFiles',
    'upstreamPrefixes',
    'metaPrefixes',
    'ignorePrefixes',
    'lockfiles',
    'rootMetaFiles',
    'sourceExtensions',
    'dockerfileRe',
  ]) {
    assert.ok(k in cfg, `config missing key: ${k}`);
  }
});

// ---------------- cleanup ----------------

test.after(() => {
  if (fs.existsSync(FIXTURE_DIR)) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
});
