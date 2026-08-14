/**
 * [knauf] KK20-252 — tests for the skill-body injection preparer.
 *
 * A skill body is load-bearing context injected as a *user* message, so the two
 * things worth pinning are: the frontmatter really is removed (the injection
 * shape that triggered the Azure refusal), and nothing else is. A regex that
 * over-matches would silently eat the first section of a skill and nobody would
 * see an error — the model would just behave slightly worse.
 */
import fs from 'fs';
import path from 'path';
import { prepareSkillBodyForInjection, stripSkillFrontmatter } from './skillPrimeBody';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

describe('[knauf] stripSkillFrontmatter', () => {
  it('removes a leading frontmatter block', () => {
    const body = [
      '---',
      'name: karl-artifacts',
      'user-invocable: true',
      '---',
      '',
      '# Heading',
    ].join('\n');
    expect(stripSkillFrontmatter(body)).toBe('# Heading');
  });

  it('removes the exact block shape our skills ship, folded scalars included', () => {
    // Reproduces the trace: a user turn opening with name/description/flags.
    const body = [
      '---',
      'name: karl-artifacts',
      'description: >-',
      '  Building KARL artifacts (the live preview panel): React, HTML, SVG,',
      '  Markdown. Use when creating or iterating an interactive UI.',
      'argument-hint: "[what to build or change]"',
      'user-invocable: true',
      'version: "2.0.0"',
      '---',
      '',
      '# KARL Artifacts',
      '',
      'body text',
    ].join('\n');
    const out = stripSkillFrontmatter(body);
    expect(out.startsWith('# KARL Artifacts')).toBe(true);
    expect(out).not.toContain('user-invocable');
    expect(out).not.toContain('name: karl-artifacts');
    expect(out).toContain('body text');
  });

  it('keeps a horizontal rule that is not leading frontmatter', () => {
    // The failure mode of a greedy regex: `---` mid-document is a `<hr>`.
    const body = '# Heading\n\nintro\n\n---\n\n## Section\n';
    expect(stripSkillFrontmatter(body)).toBe(body);
  });

  it('stops at the FIRST closing delimiter, not the last', () => {
    const body = ['---', 'name: a', '---', '', 'text', '', '---', '', 'more'].join('\n');
    const out = stripSkillFrontmatter(body);
    expect(out).toBe(['text', '', '---', '', 'more'].join('\n'));
  });

  it('leaves an unterminated frontmatter block alone', () => {
    // Fail open: returning '' here would silently delete the whole skill.
    const body = '---\nname: broken\nno closing delimiter\n';
    expect(stripSkillFrontmatter(body)).toBe(body);
  });

  it('leaves a body with no frontmatter alone', () => {
    const body = '# Just markdown\n\nwith prose.\n';
    expect(stripSkillFrontmatter(body)).toBe(body);
  });

  it('handles CRLF line endings', () => {
    const body = '---\r\nname: a\r\n---\r\n\r\n# Heading\r\n';
    expect(stripSkillFrontmatter(body)).toBe('# Heading\r\n');
  });

  it('tolerates trailing whitespace on the closing delimiter', () => {
    expect(stripSkillFrontmatter('---\nname: a\n---   \n# Heading')).toBe('# Heading');
  });

  it('never throws and never returns undefined for empty input', () => {
    expect(stripSkillFrontmatter(undefined)).toBe('');
    expect(stripSkillFrontmatter(null)).toBe('');
    expect(stripSkillFrontmatter('')).toBe('');
  });

  it('is idempotent', () => {
    const body = '---\nname: a\n---\n\n# Heading\n';
    const once = stripSkillFrontmatter(body);
    expect(stripSkillFrontmatter(once)).toBe(once);
  });
});

describe('[knauf] prepareSkillBodyForInjection against the real shipped skills', () => {
  const skillDir = path.join(REPO_ROOT, 'skill');
  const names = fs
    .readdirSync(skillDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name);

  it('finds the shipped skills', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)('strips %s frontmatter without losing content', (name) => {
    const raw = fs.readFileSync(path.join(skillDir, name, 'SKILL.md'), 'utf8');
    const prepared = prepareSkillBodyForInjection(raw);

    // The frontmatter keys must be gone...
    expect(prepared).not.toMatch(/^---/);
    expect(prepared).not.toContain('user-invocable:');
    // ...and the first markdown heading must survive intact.
    expect(prepared).toMatch(/^#\s/);
    // Nothing but the frontmatter was removed.
    const frontmatterLength = raw.length - prepared.length;
    const expectedFrontmatter = raw.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n)*/)?.[0];
    expect(frontmatterLength).toBeGreaterThan(0);
    expect(frontmatterLength).toBe(expectedFrontmatter?.length);
    expect(raw.endsWith(prepared)).toBe(true);
  });
});
