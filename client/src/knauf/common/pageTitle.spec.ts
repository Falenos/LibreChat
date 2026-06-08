import { buildPageTitle, BRAND_SHORT } from './pageTitle';

describe('[knauf] buildPageTitle (KK20-159)', () => {
  it('returns `<chatTitle> | KARL` when a chat title is provided', () => {
    expect(buildPageTitle('My research chat')).toBe('My research chat | KARL');
  });

  it('uses the appTitle as fallback when no chat title is provided', () => {
    expect(buildPageTitle(undefined, 'KARL | Knauf AI Platform')).toBe('KARL | Knauf AI Platform');
  });

  it('uses the hard-coded full brand when neither chat title nor appTitle is provided', () => {
    expect(buildPageTitle()).toBe('KARL | Knauf AI Platform');
  });

  it('ignores whitespace-only chat titles (avoids leading separator)', () => {
    expect(buildPageTitle('   ', 'KARL | Knauf AI Platform')).toBe('KARL | Knauf AI Platform');
  });

  it('falls back to the hard-coded full brand when appTitle is empty or whitespace', () => {
    expect(buildPageTitle(undefined, '')).toBe('KARL | Knauf AI Platform');
    expect(buildPageTitle(null, '   ')).toBe('KARL | Knauf AI Platform');
  });

  it('exports BRAND_SHORT as the short brand', () => {
    expect(BRAND_SHORT).toBe('KARL');
  });
});
