import {
  parsePrimaryLocale,
  resolveUserLocationContext,
  UNKNOWN_LOCATION_CONTEXT,
  USER_TIMEZONE_HEADER,
} from './locationContext';

describe('parsePrimaryLocale', () => {
  it('extracts the highest-priority locale tag', () => {
    expect(parsePrimaryLocale('de-DE,de;q=0.9,en;q=0.8')).toBe('de-DE');
  });

  it('handles a single locale with no quality values', () => {
    expect(parsePrimaryLocale('en-US')).toBe('en-US');
  });

  it('returns undefined for missing/empty input', () => {
    expect(parsePrimaryLocale(undefined)).toBeUndefined();
    expect(parsePrimaryLocale('')).toBeUndefined();
  });

  it('treats a wildcard-only header as no signal', () => {
    expect(parsePrimaryLocale('*')).toBeUndefined();
  });
});

describe('resolveUserLocationContext', () => {
  it('never defaults to a specific country/region when no headers are present', () => {
    expect(resolveUserLocationContext(undefined)).toBe(UNKNOWN_LOCATION_CONTEXT);
    expect(resolveUserLocationContext({})).toBe(UNKNOWN_LOCATION_CONTEXT);
  });

  it('composes locale from Accept-Language', () => {
    expect(resolveUserLocationContext({ 'accept-language': 'de-DE,de;q=0.9' })).toBe(
      'Locale: de-DE',
    );
  });

  it('composes locale and timezone when both are present', () => {
    expect(
      resolveUserLocationContext({
        'accept-language': 'de-DE,de;q=0.9',
        [USER_TIMEZONE_HEADER]: 'Europe/Berlin',
      }),
    ).toBe('Locale: de-DE, Timezone: Europe/Berlin');
  });

  it('composes timezone only when Accept-Language is absent', () => {
    expect(
      resolveUserLocationContext({
        [USER_TIMEZONE_HEADER]: 'Europe/Berlin',
      }),
    ).toBe('Timezone: Europe/Berlin');
  });

  it('handles array-valued headers by taking the first entry', () => {
    expect(
      resolveUserLocationContext({
        'accept-language': ['de-DE,de;q=0.9', 'en-US'],
      }),
    ).toBe('Locale: de-DE');
  });

  it('never states or implies a US default for a non-US locale', () => {
    const result = resolveUserLocationContext({ 'accept-language': 'de-DE' });
    expect(result).not.toMatch(/US|United States/i);
  });
});
