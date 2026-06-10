import { looksLikeMarkdown } from './markdownDetect';

describe('looksLikeMarkdown', () => {
  it('returns false for empty or whitespace-only input', () => {
    expect(looksLikeMarkdown('')).toBe(false);
    expect(looksLikeMarkdown('   ')).toBe(false);
    expect(looksLikeMarkdown('\n\n')).toBe(false);
  });

  it('returns false for plain text', () => {
    expect(looksLikeMarkdown('You are a helpful assistant.')).toBe(false);
    expect(looksLikeMarkdown('Answer questions about dogs.\nBe friendly.')).toBe(false);
  });

  it('detects headings (# to ###)', () => {
    expect(looksLikeMarkdown('## Role\nYou are a dog.')).toBe(true);
    expect(looksLikeMarkdown('# Title')).toBe(true);
    expect(looksLikeMarkdown('### Sub-section')).toBe(true);
  });

  it('does not match #### or deeper headings', () => {
    expect(looksLikeMarkdown('#### Deep heading')).toBe(false);
  });

  it('detects **bold** text', () => {
    expect(looksLikeMarkdown('Be **precise** and factual.')).toBe(true);
  });

  it('detects unordered lists (- and *)', () => {
    expect(looksLikeMarkdown('- First item\n- Second item')).toBe(true);
    expect(looksLikeMarkdown('* Bullet point')).toBe(true);
  });

  it('detects ordered lists', () => {
    expect(looksLikeMarkdown('1. Step one\n2. Step two')).toBe(true);
  });

  it('handles multiline with markdown on non-first line', () => {
    expect(looksLikeMarkdown('Some intro text\n## Role\nDetails')).toBe(true);
  });
});
