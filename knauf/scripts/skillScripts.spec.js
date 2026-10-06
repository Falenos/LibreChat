'use strict';

// KK20-398 — the Python helpers bundled with the deployment skills (skill/*/scripts/*.py)
// run only inside the code sandbox, so nothing else in CI ever parses them. A syntax
// error there surfaces as a failed tool call in a user's chat. This spec compiles every
// helper and exercises the pure-logic parts that need no third-party library.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skill');
// KARL_SKILL_PYTHON points the office-stack tests at an interpreter that has the sandbox's
// libraries (openpyxl, lxml); without them those tests skip and say why.
const PYTHON = process.env.KARL_SKILL_PYTHON || 'python3';
const hasPython = spawnSync(PYTHON, ['--version']).status === 0;
const skip = hasPython ? false : `${PYTHON} is not on PATH`;
const hasModules = (...names) =>
  hasPython &&
  spawnSync(PYTHON, ['-B', '-c', names.map((name) => `import ${name}`).join('; ')]).status === 0;
const hasSoffice = spawnSync('soffice', ['--version']).status === 0;
const officeSkip = hasModules('openpyxl', 'lxml')
  ? false
  : 'openpyxl and lxml are not installed for this interpreter (set KARL_SKILL_PYTHON)';

function helperScripts() {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = path.join(SKILLS_DIR, entry.name, 'scripts');
      return fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((name) => name.endsWith('.py'))
            .map((name) => path.join(dir, name))
        : [];
    });
}

/** Run Python with -B so no __pycache__ lands in skill/ (it would ship in the image). */
function python(code, env = {}) {
  const result = spawnSync(PYTHON, ['-B', '-c', code], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('finds the Office helpers', () => {
  const names = helperScripts().map((file) => path.relative(SKILLS_DIR, file));
  for (const expected of [
    'karl-brand/scripts/knauf_brand.py',
    'karl-docx/scripts/karl_docx.py',
    'karl-pdf/scripts/karl_pdf.py',
    'karl-pptx/scripts/karl_pptx.py',
    'karl-xlsx/scripts/karl_xlsx.py',
  ]) {
    assert.ok(names.includes(expected), `${expected} is missing`);
  }
});

test('every bundled helper compiles', { skip }, () => {
  const files = helperScripts();
  const result = spawnSync(
    PYTHON,
    [
      '-B',
      '-c',
      'import sys\nfor p in sys.argv[1:]:\n    compile(open(p, encoding="utf-8").read(), p, "exec")\nprint(len(sys.argv) - 1)',
      ...files,
    ],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), String(files.length));
});

test('karl_xlsx adds missing _xlfn. prefixes outside string literals only', { skip }, () => {
  const out = python(
    [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(path.join(SKILLS_DIR, 'karl-xlsx/scripts'))})`,
      'import karl_xlsx as k',
      'cases = ["=TEXTJOIN(\\", \\",TRUE,A1:A3)", "=_xlfn.MAXIFS(B:B,A:A,1)", "=\\"textjoin(\\"&A1", "=SUM(A1:A3)", "=ifs(A1>1,1,TRUE,0)"]',
      'print(json.dumps([k._prefix(c) for c in cases]))',
    ].join('\n'),
  );
  assert.deepEqual(JSON.parse(out), [
    '=_xlfn.TEXTJOIN(", ",TRUE,A1:A3)',
    '=_xlfn.MAXIFS(B:B,A:A,1)',
    '="textjoin("&A1',
    '=SUM(A1:A3)',
    '=_xlfn.IFS(A1>1,1,TRUE,0)',
  ]);
});

test('karl_xlsx flags dynamic-array functions it cannot compute', { skip }, () => {
  const out = python(
    [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(path.join(SKILLS_DIR, 'karl-xlsx/scripts'))})`,
      'import karl_xlsx as k',
      'print(json.dumps([k._outside_strings(f, k.UNSUPPORTED_RE) for f in ["=XLOOKUP(1,A:A,B:B)", "=\\"FILTER(\\"&A1", "=INDEX(B:B,MATCH(1,A:A,0))"]]))',
    ].join('\n'),
  );
  assert.deepEqual(JSON.parse(out), [['XLOOKUP'], [], []]);
});

test('knauf_brand serves tokens in the forms Office libraries take', { skip }, () => {
  const out = python(
    [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(path.join(SKILLS_DIR, 'karl-brand/scripts'))})`,
      'import knauf_brand as kb',
      'print(json.dumps([kb.hex("ink.heading"), kb.rgb("brand.cyanBlue"), kb.token("categorical.1"), kb.install_fonts()["body"]]))',
    ].join('\n'),
    // Keep the test independent of whether licensed fonts are checked in.
    { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'kb-')) },
  );
  const [heading, cyan, second, body] = JSON.parse(out);
  assert.equal(heading, '003778');
  assert.deepEqual(cyan, [0, 153, 222]);
  assert.match(second, /^#[0-9A-F]{6}$/);
  assert.ok(['Arial', 'Knauf Screen'].includes(body), body);
});

test('office_qa parses page ranges as the helpers document them', { skip }, () => {
  const out = python(
    [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(path.join(SKILLS_DIR, 'karl-docx/scripts'))})`,
      'import office_qa as q',
      'print(json.dumps([q.parse_pages("1-3,7"), q.parse_pages(None), q.parse_pages(" 2 ")]))',
    ].join('\n'),
  );
  assert.deepEqual(JSON.parse(out), [[1, 2, 3, 7], null, [2]]);
});

test('office_qa flags template leftovers, not the word "placeholder" in prose', { skip }, () => {
  const out = python(
    [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(path.join(SKILLS_DIR, 'karl-docx/scripts'))})`,
      'import office_qa as q',
      'texts = ["Lorem ipsum dolor", "[Placeholder] title", "TODO: fill", "sample text, not a placeholder", "Replace {placeholder}"]',
      'print(json.dumps([bool(q.PLACEHOLDER_RE.search(t)) for t in texts]))',
    ].join('\n'),
  );
  assert.deepEqual(JSON.parse(out), [true, true, true, false, true]);
});

// Review of #388: text from a PDF is data — a crafted table cell must not become a formula.
test('karl_pdf neutralises formula-leading table text, keeps signed numbers', { skip }, () => {
  const out = python(
    [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(path.join(SKILLS_DIR, 'karl-pdf/scripts'))})`,
      'import karl_pdf as k',
      'cells = ["=WEBSERVICE(\\"http://x\\")", "@SUM(1)", "+cmd|x", "-12", "+11%", "-", "Item", ""]',
      'print(json.dumps([k.spreadsheet_text(c) for c in cells]))',
    ].join('\n'),
  );
  assert.deepEqual(JSON.parse(out), [
    '\'=WEBSERVICE("http://x")',
    "'@SUM(1)",
    "'+cmd|x",
    '-12',
    '+11%',
    '-',
    'Item',
    '',
  ]);
});

test(
  'karl_pdf writes extracted XLSX cells as text, never as formulas',
  { skip: officeSkip },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karl-tables-'));
    const out = python(
      [
        'import sys, json, openpyxl',
        `sys.path.insert(0, ${JSON.stringify(path.join(SKILLS_DIR, 'karl-pdf/scripts'))})`,
        'import karl_pdf as k',
        `target = ${JSON.stringify(path.join(dir, 't.xlsx'))}`,
        'k.write_tables([("p1_t1", [["=1+1", "-12"]])], target)',
        'ws = openpyxl.load_workbook(target).active',
        'print(json.dumps([[c.value, c.data_type, bool(c.quotePrefix)] for c in ws[1]]))',
      ].join('\n'),
    );
    assert.deepEqual(JSON.parse(out), [
      ['=1+1', 's', true],
      ['-12', 's', false],
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  },
);

// Review of #388: a failed recalc must not have replaced the workbook already.
test('karl_xlsx replaces a workbook atomically and leaves no temp file', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karl-recalc-'));
  const target = path.join(dir, 'model.xlsx');
  const source = path.join(dir, 'new.bin');
  fs.writeFileSync(target, 'original');
  fs.writeFileSync(source, 'validated');
  python(
    [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(path.join(SKILLS_DIR, 'karl-xlsx/scripts'))})`,
      'import karl_xlsx as k',
      `k.replace_atomically(${JSON.stringify(source)}, ${JSON.stringify(target)})`,
      'try:',
      `    k.replace_atomically(${JSON.stringify(path.join(dir, 'missing.bin'))}, ${JSON.stringify(target)})`,
      'except FileNotFoundError:',
      '    pass',
    ].join('\n'),
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'validated');
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.startsWith('.karl-recalc-')),
    [],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test(
  'karl_xlsx recalc leaves a workbook with formula errors untouched',
  { skip: officeSkip || (hasSoffice ? false : 'LibreOffice (soffice) is not on PATH') },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karl-recalc-e2e-'));
    const book = path.join(dir, 'model.xlsx');
    python(
      [
        'import openpyxl',
        'wb = openpyxl.Workbook(); ws = wb.active',
        "ws['A1'] = 2; ws['B1'] = '=A1*3'; ws['B2'] = '=1/0'",
        `wb.save(${JSON.stringify(book)})`,
      ].join('\n'),
    );
    const before = fs.readFileSync(book);
    const run = spawnSync(
      PYTHON,
      ['-B', path.join(SKILLS_DIR, 'karl-xlsx/scripts/karl_xlsx.py'), 'recalc', book],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
    );
    assert.equal(run.status, 1, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.written, false);
    assert.deepEqual(report.errors['#DIV/0!'], ["'Sheet'!B2"]);
    assert.ok(fs.readFileSync(book).equals(before), 'the workbook must not change');
    assert.deepEqual(fs.readdirSync(dir), ['model.xlsx']);
    fs.rmSync(dir, { recursive: true, force: true });
  },
);

// Review of #388: date results follow the workbook's date system (1904 vs 1900).
test('karl_xlsx serialises date results in the workbook epoch', { skip: officeSkip }, () => {
  const out = python(
    [
      'import sys, json, datetime, io, zipfile',
      'from lxml import etree',
      `sys.path.insert(0, ${JSON.stringify(path.join(SKILLS_DIR, 'karl-xlsx/scripts'))})`,
      'import karl_xlsx as k',
      'def epoch(flag):',
      '    buf = io.BytesIO()',
      '    with zipfile.ZipFile(buf, "w") as z:',
      `        z.writestr("xl/workbook.xml", f'<workbook xmlns="{k.MAIN}"><workbookPr{flag}/></workbook>')`,
      '    return k._workbook_epoch(zipfile.ZipFile(buf))',
      'serials = []',
      'for flag in (\' date1904="1"\', "", \' date1904="false"\'):',
      `    cell = etree.fromstring(f'<c xmlns="{k.MAIN}" r="A1"><f>DATE(2026,1,1)</f></c>')`,
      '    k._cell_value(cell, datetime.datetime(2026, 1, 1), epoch(flag))',
      '    serials.append(cell.find(f"{{{k.MAIN}}}v").text)',
      'print(json.dumps(serials))',
    ].join('\n'),
  );
  assert.deepEqual(JSON.parse(out), ['44561', '46023', '46023']);
});

test('no Python bytecode is committed under skill/', () => {
  // Neither .gitignore nor .dockerignore excludes __pycache__, and the image COPYs skill/
  // whole. A helper imported locally without -B writes its .pyc next to it; committed,
  // that stale bytecode would ship. (The Python runs in this spec all use -B.)
  const tracked = spawnSync('git', ['ls-files', '--', 'skill'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(tracked.status, 0, tracked.stderr);
  const bytecode = tracked.stdout
    .split('\n')
    .filter((file) => file.includes('/__pycache__/') || file.endsWith('.pyc'));
  assert.deepEqual(bytecode, []);
});
