// [knauf] Tests for the requireMigrationAccess middleware.
'use strict';

const mockIsEmailAllowed = jest.fn();

jest.mock('~/server/knauf/migrationAllowlist', () => ({
  isEmailAllowed: mockIsEmailAllowed,
}));

const requireMigrationAccess = require('~/server/middleware/requireMigrationAccess');

const createReq = (email) => ({
  user: email !== undefined ? { email } : undefined,
});

const createRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe('requireMigrationAccess middleware', () => {
  describe('pass-through — no req.user (unauthenticated)', () => {
    it('calls next() without checking DB when req.user is undefined', async () => {
      const next = jest.fn();
      await requireMigrationAccess(createReq(undefined), createRes(), next);
      expect(next).toHaveBeenCalledWith();
      expect(mockIsEmailAllowed).not.toHaveBeenCalled();
    });
  });

  describe('authenticated but no email claim', () => {
    it('returns 401 when req.user exists but has no email', async () => {
      const next = jest.fn();
      const res = createRes();
      await requireMigrationAccess(createReq(''), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockIsEmailAllowed).not.toHaveBeenCalled();
    });
  });

  describe('access denied', () => {
    it('returns 403 with correct code when email is not allowed', async () => {
      mockIsEmailAllowed.mockResolvedValue(false);
      const next = jest.fn();
      const res = createRes();

      await requireMigrationAccess(createReq('blocked@knauf.com'), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'MIGRATION_ACCESS_DENIED' }),
      );
    });

    it('includes a human-readable message in the 403 response', async () => {
      mockIsEmailAllowed.mockResolvedValue(false);
      const res = createRes();

      await requireMigrationAccess(createReq('blocked@knauf.com'), res, jest.fn());

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.any(String) }),
      );
    });
  });

  describe('access granted', () => {
    it('calls next() when email is on the allowlist', async () => {
      mockIsEmailAllowed.mockResolvedValue(true);
      const next = jest.fn();
      const res = createRes();

      await requireMigrationAccess(createReq('allowed@knauf.com'), res, next);

      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('error handling (fail closed)', () => {
    it('returns 503 with MIGRATION_ACCESS_UNAVAILABLE when isEmailAllowed throws', async () => {
      mockIsEmailAllowed.mockRejectedValue(new Error('DB connection lost'));
      const next = jest.fn();
      const res = createRes();

      await requireMigrationAccess(createReq('ali@knauf.com'), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'MIGRATION_ACCESS_UNAVAILABLE' }),
      );
    });
  });
});
// End [knauf]
