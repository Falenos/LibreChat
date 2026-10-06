const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const {
  isPrivateQaRender,
  blockedCodeOutputReason,
  zipEntryNames,
  resetCodeOutputPolicyCache,
} = require('./codeOutputPolicy');

const TTF = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x0c]), Buffer.alloc(64)]);
const WOFF2 = Buffer.concat([Buffer.from('wOF2', 'latin1'), Buffer.alloc(64)]);

const zipOf = async (entries) => {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(entries)) {
    zip.file(name, data);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
};

describe('[knauf] code output policy (KK20-397)', () => {
  const previousDir = process.env.DEPLOYMENT_SKILLS_DIR;
  let skillsDir;

  beforeEach(() => {
    skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knauf-skills-'));
    fs.mkdirSync(path.join(skillsDir, 'karl-brand', 'sandbox'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'karl-brand', 'sandbox', 'knauf-fonts.zip'),
      'SECRET-ZIP',
    );
    fs.mkdirSync(path.join(skillsDir, 'karl-brand', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'karl-brand', 'assets', 'wordmark.png'), 'PUBLIC-PNG');
    process.env.DEPLOYMENT_SKILLS_DIR = skillsDir;
    resetCodeOutputPolicyCache();
  });

  afterEach(() => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    if (previousDir === undefined) {
      delete process.env.DEPLOYMENT_SKILLS_DIR;
    } else {
      process.env.DEPLOYMENT_SKILLS_DIR = previousDir;
    }
    resetCodeOutputPolicyCache();
  });

  it('recognises visual-QA renders by their reserved folder only', () => {
    expect(isPrivateQaRender('_karl_qa/sheet-1.png')).toBe(true);
    expect(isPrivateQaRender('/mnt/data/_karl_qa/page-01.png')).toBe(true);
    expect(isPrivateQaRender('reports/_karl_qa/sheet-1.png')).toBe(false);
    expect(isPrivateQaRender('karl_qa.png')).toBe(false);
  });

  it('blocks font files by extension or by content, whatever they are called', () => {
    expect(
      blockedCodeOutputReason({ name: 'KnaufScreen-Regular.ttf', buffer: Buffer.from('x') }),
    ).toBe('font');
    expect(blockedCodeOutputReason({ name: 'renamed.bin', buffer: TTF })).toBe('font');
    expect(blockedCodeOutputReason({ name: 'renamed.dat', buffer: WOFF2 })).toBe('font');
  });

  it('does not mistake text that happens to start like a font tag for a font', () => {
    expect(
      blockedCodeOutputReason({ name: 'names.csv', buffer: Buffer.from('OTTO,Maria\n') }),
    ).toBeNull();
    expect(blockedCodeOutputReason({ name: 'flag.txt', buffer: Buffer.from('true\n') })).toBeNull();
  });

  it('blocks a byte-exact copy of a sandbox-only skill asset, not a public one', () => {
    expect(blockedCodeOutputReason({ name: 'copy.zip', buffer: Buffer.from('SECRET-ZIP') })).toBe(
      'restricted_asset',
    );
    expect(
      blockedCodeOutputReason({ name: 'logo.png', buffer: Buffer.from('PUBLIC-PNG') }),
    ).toBeNull();
  });

  it('blocks a re-zipped font set but not an Office document', async () => {
    const fontArchive = await zipOf({ 'fonts/KnaufScreen-Bold.otf': TTF, 'readme.txt': 'x' });
    expect(blockedCodeOutputReason({ name: 'fonts.zip', buffer: fontArchive })).toBe(
      'font_archive',
    );

    // A DOCX with an embedded (obfuscated) font keeps it under word/fonts/*.odttf.
    const docx = await zipOf({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': '<w:document/>',
      'word/fonts/font1.odttf': TTF,
    });
    expect(blockedCodeOutputReason({ name: 'report.docx', buffer: docx })).toBeNull();
    expect(
      blockedCodeOutputReason({ name: 'data.csv', buffer: Buffer.from('a,b\n1,2\n') }),
    ).toBeNull();
  });

  it('reads zip central-directory names and rejects non-zips', async () => {
    // JSZip writes an explicit directory entry for b/.
    expect(zipEntryNames(await zipOf({ 'a.txt': 'a', 'b/c.txt': 'c' }))).toEqual([
      'a.txt',
      'b/',
      'b/c.txt',
    ]);
    expect(zipEntryNames(Buffer.from('%PDF-1.7'))).toBeNull();
  });
});
