/**
 * Feature gates are config-driven — functions check rumEnabled / browserLogsEnabled flags
 * from the startup config API.
 */
import { isRumEnabled, isLogsEnabled, isDatadogEnabled } from './isEnabled';

describe('isEnabled', () => {
  describe('isRumEnabled', () => {
    it('returns true when rumEnabled is true', () => {
      expect(isRumEnabled({ rumEnabled: true })).toBe(true);
    });

    it('returns false when rumEnabled is false', () => {
      expect(isRumEnabled({ rumEnabled: false })).toBe(false);
    });

    it('returns false for null/undefined config', () => {
      expect(isRumEnabled(null)).toBe(false);
      expect(isRumEnabled(undefined)).toBe(false);
    });

    it('returns false for empty config', () => {
      expect(isRumEnabled({})).toBe(false);
    });
  });

  describe('isLogsEnabled', () => {
    it('returns true when browserLogsEnabled is true', () => {
      expect(isLogsEnabled({ browserLogsEnabled: true })).toBe(true);
    });

    it('returns false when browserLogsEnabled is false', () => {
      expect(isLogsEnabled({ browserLogsEnabled: false })).toBe(false);
    });

    it('returns false for null/undefined config', () => {
      expect(isLogsEnabled(null)).toBe(false);
      expect(isLogsEnabled(undefined)).toBe(false);
    });
  });

  describe('isDatadogEnabled', () => {
    it('returns true when RUM is enabled', () => {
      expect(isDatadogEnabled({ rumEnabled: true, browserLogsEnabled: false })).toBe(true);
    });

    it('returns true when browser logs are enabled', () => {
      expect(isDatadogEnabled({ rumEnabled: false, browserLogsEnabled: true })).toBe(true);
    });

    it('returns true when both are enabled', () => {
      expect(isDatadogEnabled({ rumEnabled: true, browserLogsEnabled: true })).toBe(true);
    });

    it('returns false when both are disabled', () => {
      expect(isDatadogEnabled({ rumEnabled: false, browserLogsEnabled: false })).toBe(false);
    });

    it('returns false for null/undefined config', () => {
      expect(isDatadogEnabled(null)).toBe(false);
      expect(isDatadogEnabled(undefined)).toBe(false);
    });
  });
});
