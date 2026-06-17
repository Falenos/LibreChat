/**
 * Feature gates are hostname-based — functions accept an optional hostname
 * parameter for testability (defaults to globalThis.location.hostname).
 */
import { isRumEnabled, isLogsEnabled, isDatadogEnabled, isKnownHost } from './isEnabled';

describe('isEnabled', () => {
  describe('isKnownHost', () => {
    it.each([
      'agentic-karl.knauf.com',
      'agentic-karl.agk.prod.knauf.digital',
      'agentic-karl.agk.dev.knauf.digital',
      'agentic-karl.dev.knauf.digital',
    ])('returns true for %s', (hostname) => {
      expect(isKnownHost(hostname)).toBe(true);
    });

    it.each(['localhost', '', 'example.com'])('returns false for "%s"', (hostname) => {
      expect(isKnownHost(hostname)).toBe(false);
    });
  });

  describe('isRumEnabled / isLogsEnabled', () => {
    it('returns true on prod hostname', () => {
      expect(isRumEnabled('agentic-karl.knauf.com')).toBe(true);
      expect(isLogsEnabled('agentic-karl.knauf.com')).toBe(true);
    });

    it('returns true on AGK dev hostname', () => {
      expect(isRumEnabled('agentic-karl.agk.dev.knauf.digital')).toBe(true);
      expect(isLogsEnabled('agentic-karl.agk.dev.knauf.digital')).toBe(true);
    });

    it('returns false on localhost', () => {
      expect(isRumEnabled('localhost')).toBe(false);
      expect(isLogsEnabled('localhost')).toBe(false);
    });

    it('returns false on unknown hostname', () => {
      expect(isRumEnabled('example.com')).toBe(false);
      expect(isLogsEnabled('example.com')).toBe(false);
    });
  });

  describe('isDatadogEnabled', () => {
    it('returns true on known Knauf hostname', () => {
      expect(isDatadogEnabled('agentic-karl.agk.prod.knauf.digital')).toBe(true);
    });

    it('returns false on localhost', () => {
      expect(isDatadogEnabled('localhost')).toBe(false);
    });
  });
});
