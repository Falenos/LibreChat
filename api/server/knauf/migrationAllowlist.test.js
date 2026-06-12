// [knauf] Tests for the migration allowlist service.
'use strict';

const mockFindOne = jest.fn();

jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return {
    ...actual,
    models: {
      MigrationAllowlist: { findOne: mockFindOne },
    },
    model: jest.fn(() => ({ findOne: mockFindOne })),
  };
});

const { isEmailAllowed } = require('~/server/knauf/migrationAllowlist');

const mockDoc = (email) => ({
  lean: () => Promise.resolve(email ? { emailNormalized: email } : null),
});

describe('migrationAllowlist service', () => {
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
      expect(mockFindOne).toHaveBeenCalledWith({
        $expr: { $eq: [{ $toLower: '$emailNormalized' }, 'ali@knauf.com'] },
      });
    });

    it('trims whitespace from the email before querying', async () => {
      mockFindOne.mockReturnValue(mockDoc(null));
      await isEmailAllowed('  ali@knauf.com  ');
      expect(mockFindOne).toHaveBeenCalledWith({
        $expr: { $eq: [{ $toLower: '$emailNormalized' }, 'ali@knauf.com'] },
      });
    });

    it('normalises mixed-case input so it matches a mixed-case DB value', async () => {
      mockFindOne.mockReturnValue(mockDoc('Ali.Karimizandi@Knauf.com'));
      // The query uses $toLower on both sides, so 'ALI...' maps to key 'ali...'
      // and the DB $toLower makes 'Ali.Karimizandi@Knauf.com' also lowercase
      expect(await isEmailAllowed('ALI.KARIMIZANDI@KNAUF.COM')).toBe(true);
    });
  });

  describe('isEmailAllowed — TTL cache', () => {
    it('skips DB on second call when TTL has not expired', async () => {
      let isEmailAllowedCached;

      jest.isolateModules(() => {
        process.env.MIGRATION_ALLOWLIST_CACHE_TTL_MINUTES = '10';
        // Re-mock mongoose inside the isolated scope
        jest.mock('mongoose', () => {
          const actual = jest.requireActual('mongoose');
          return {
            ...actual,
            models: { MigrationAllowlist: { findOne: mockFindOne } },
            model: jest.fn(() => ({ findOne: mockFindOne })),
          };
        });
        isEmailAllowedCached = require('~/server/knauf/migrationAllowlist').isEmailAllowed;
      });

      mockFindOne.mockReturnValue(mockDoc('cached@knauf.com'));

      // First call: hits DB
      await isEmailAllowedCached('cached@knauf.com');
      // Second call: should read from cache, not DB
      await isEmailAllowedCached('cached@knauf.com');

      expect(mockFindOne).toHaveBeenCalledTimes(1);

      delete process.env.MIGRATION_ALLOWLIST_CACHE_TTL_MINUTES;
    });

    it('re-queries DB after cache expires', async () => {
      jest.useFakeTimers();

      let isEmailAllowedCached;

      jest.isolateModules(() => {
        process.env.MIGRATION_ALLOWLIST_CACHE_TTL_MINUTES = '1';
        jest.mock('mongoose', () => {
          const actual = jest.requireActual('mongoose');
          return {
            ...actual,
            models: { MigrationAllowlist: { findOne: mockFindOne } },
            model: jest.fn(() => ({ findOne: mockFindOne })),
          };
        });
        isEmailAllowedCached = require('~/server/knauf/migrationAllowlist').isEmailAllowed;
      });

      mockFindOne.mockReturnValue(mockDoc('expiry@knauf.com'));

      // First call
      await isEmailAllowedCached('expiry@knauf.com');

      // Advance past the 1-minute TTL
      jest.advanceTimersByTime(61 * 1000);

      // Second call after expiry
      await isEmailAllowedCached('expiry@knauf.com');

      expect(mockFindOne).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
      delete process.env.MIGRATION_ALLOWLIST_CACHE_TTL_MINUTES;
    });
  });
});
// End [knauf]
