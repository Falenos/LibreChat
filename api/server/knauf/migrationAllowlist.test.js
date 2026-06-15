// [knauf] Tests for the migration allowlist service.
'use strict';

const mockFindOne = jest.fn();

jest.mock('mongoose', () => ({
  models: {
    MigrationAllowlist: { findOne: mockFindOne },
  },
}));

const { isEmailAllowed } = require('~/server/knauf/migrationAllowlist');

const mockDoc = (email) => ({
  lean: () => Promise.resolve(email ? { emailNormalized: email } : null),
});

describe('migrationAllowlist service', () => {
  beforeEach(() => {
    mockFindOne.mockClear();
  });

  describe('isEmailAllowed — input validation', () => {
    it('returns false for empty string', async () => {
      expect(await isEmailAllowed('')).toBe(false);
      expect(mockFindOne).not.toHaveBeenCalled();
    });

    it('returns false for null', async () => {
      expect(await isEmailAllowed(null)).toBe(false);
      expect(mockFindOne).not.toHaveBeenCalled();
    });

    it('returns false for undefined', async () => {
      expect(await isEmailAllowed(undefined)).toBe(false);
      expect(mockFindOne).not.toHaveBeenCalled();
    });
  });

  describe('isEmailAllowed — DB lookup', () => {
    it('returns true when email is found in DB', async () => {
      mockFindOne.mockReturnValue(mockDoc('ali@knauf.com'));
      expect(await isEmailAllowed('ali@knauf.com')).toBe(true);
    });

    it('returns false when email is not found in DB', async () => {
      mockFindOne.mockReturnValue(mockDoc(null));
      expect(await isEmailAllowed('unknown@knauf.com')).toBe(false);
    });

    it('lowercases the email before querying', async () => {
      mockFindOne.mockReturnValue(mockDoc(null));
      await isEmailAllowed('ALI@Knauf.COM');
      expect(mockFindOne).toHaveBeenCalledWith({ emailNormalized: 'ali@knauf.com' });
    });

    it('trims whitespace from the email before querying', async () => {
      mockFindOne.mockReturnValue(mockDoc(null));
      await isEmailAllowed('  ali@knauf.com  ');
      expect(mockFindOne).toHaveBeenCalledWith({ emailNormalized: 'ali@knauf.com' });
    });

    it('normalises mixed-case input so it matches the lowercased DB value', async () => {
      mockFindOne.mockReturnValue(mockDoc('ali.karimizandi@knauf.com'));
      expect(await isEmailAllowed('ALI.KARIMIZANDI@KNAUF.COM')).toBe(true);
    });
  });


  describe('isEmailAllowed — TTL=0 (default, no cache)', () => {
    it('hits DB on every call when TTL is 0', async () => {
      mockFindOne.mockReturnValue(mockDoc('ali@knauf.com'));
      await isEmailAllowed('ali@knauf.com');
      await isEmailAllowed('ali@knauf.com');
      expect(mockFindOne).toHaveBeenCalledTimes(2);
    });
  });

  describe('isEmailAllowed — TTL cache', () => {
    it('skips DB on second call when TTL has not expired', async () => {
      let isEmailAllowedCached;

      jest.isolateModules(() => {
        process.env.MIGRATION_ALLOWLIST_CACHE_TTL_MINUTES = '10';
        jest.mock('mongoose', () => ({
          models: { MigrationAllowlist: { findOne: mockFindOne } },
        }));
        isEmailAllowedCached = require('~/server/knauf/migrationAllowlist').isEmailAllowed;
      });

      mockFindOne.mockReturnValue(mockDoc('cached@knauf.com'));

      await isEmailAllowedCached('cached@knauf.com');
      await isEmailAllowedCached('cached@knauf.com');

      expect(mockFindOne).toHaveBeenCalledTimes(1);

      delete process.env.MIGRATION_ALLOWLIST_CACHE_TTL_MINUTES;
    });

    it('re-queries DB after cache expires', async () => {
      jest.useFakeTimers();

      let isEmailAllowedCached;

      jest.isolateModules(() => {
        process.env.MIGRATION_ALLOWLIST_CACHE_TTL_MINUTES = '1';
        jest.mock('mongoose', () => ({
          models: { MigrationAllowlist: { findOne: mockFindOne } },
        }));
        isEmailAllowedCached = require('~/server/knauf/migrationAllowlist').isEmailAllowed;
      });

      mockFindOne.mockReturnValue(mockDoc('expiry@knauf.com'));

      await isEmailAllowedCached('expiry@knauf.com');
      jest.advanceTimersByTime(61 * 1000);
      await isEmailAllowedCached('expiry@knauf.com');

      expect(mockFindOne).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
      delete process.env.MIGRATION_ALLOWLIST_CACHE_TTL_MINUTES;
    });
  });
});
// End [knauf]
