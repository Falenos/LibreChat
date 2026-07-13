import { resolveBrowserLocationContext, UNKNOWN_LOCATION_CONTEXT } from './locationContext';

describe('resolveBrowserLocationContext', () => {
  it('composes locale and timezone from Intl.DateTimeFormat', () => {
    const result = resolveBrowserLocationContext();
    // jsdom's default Intl resolves to en-US/UTC — assert shape, not the
    // specific (test-environment) values, since asserting a fixed locale
    // here would defeat the point of the test (never assume a country).
    expect(result).toMatch(
      /^Location hint only, not a confirmed physical location or country \(Locale: .+\)$/,
    );
  });

  it('falls back to the neutral, non-country-specific string if Intl throws', () => {
    const original = Intl.DateTimeFormat;
    // @ts-expect-error -- intentionally breaking Intl for this test
    Intl.DateTimeFormat = () => {
      throw new Error('boom');
    };
    try {
      expect(resolveBrowserLocationContext()).toBe(UNKNOWN_LOCATION_CONTEXT);
    } finally {
      Intl.DateTimeFormat = original;
    }
  });

  it('never hardcodes a country/region name in the fallback text', () => {
    expect(UNKNOWN_LOCATION_CONTEXT).not.toMatch(/United States|\bUS\b|Germany|\bDE\b/);
  });
});
