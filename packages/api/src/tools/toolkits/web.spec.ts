import { buildWebSearchContext, buildWebSearchDynamicContext } from './web';

jest.mock('librechat-data-provider', () => ({
  Tools: { web_search: 'web_search' },
  replaceSpecialVars: jest.fn(({ now }: { now?: string }) => now ?? 'NOW'),
}));

describe('web search context', () => {
  it('keeps static context free of volatile date replacements', () => {
    const context = buildWebSearchContext();

    expect(context).toContain('web_search');
    expect(context).not.toContain('NOW');
    expect(context).not.toContain('{{iso_datetime}}');
  });

  it('builds dynamic context from the supplied conversation anchor', () => {
    const context = buildWebSearchDynamicContext('2024-01-02T03:04:05.000Z');
    const secondContext = buildWebSearchDynamicContext('2024-01-02T03:04:05.000Z');

    expect(context).toBe(
      '# `web_search` Runtime Context\nConversation Date & Time: 2024-01-02T03:04:05.000Z',
    );
    expect(secondContext).toBe(context);
  });
});

// [knauf] KK20-201 — regression coverage for the deterministic location
// context threaded into the web-search tool prompt. See
// packages/api/src/knauf/context/locationContext.ts for the resolution
// logic and root-cause writeup.
describe('buildWebSearchContext location context', () => {
  it('includes the resolved location context when provided', () => {
    const result = buildWebSearchContext('Locale: de-DE, Timezone: Europe/Berlin');
    expect(result).toContain('Current User Location: Locale: de-DE, Timezone: Europe/Berlin');
  });

  it('never defaults to a specific country when no location is provided', () => {
    const result = buildWebSearchContext();
    expect(result).toContain('Current User Location:');
    expect(result).not.toMatch(/United States|\bUS\b/);
    expect(result).toContain('do not assume any specific country or region');
  });
});
// End [knauf]
