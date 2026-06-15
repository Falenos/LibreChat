// [knauf] Tests for GET /api/knauf/migration/access route.
'use strict';

const express = require('express');
const request = require('supertest');

const mockIsEmailAllowed = jest.fn();

jest.mock('~/server/knauf/migrationAllowlist', () => ({
  isEmailAllowed: mockIsEmailAllowed,
}));

// Mock requireJwtAuth to inject req.user directly — avoids needing a real JWT
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
}));

const migrationAccessRouter = require('~/server/routes/knauf/migrationAccess');

const buildApp = (email) => {
  const app = express();
  app.use(express.json());
  // Inject user before the router (simulates a prior requireJwtAuth)
  app.use((req, _res, next) => {
    if (email !== undefined) req.user = { email };
    next();
  });
  app.use('/', migrationAccessRouter);
  return app;
};

describe('GET /api/knauf/migration/access', () => {
  describe('happy path', () => {
    it('returns { allowed: true } when email is on the allowlist', async () => {
      mockIsEmailAllowed.mockResolvedValue(true);
      const res = await request(buildApp('ali@knauf.com')).get('/');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ allowed: true });
    });

    it('returns { allowed: false } when email is not on the allowlist', async () => {
      mockIsEmailAllowed.mockResolvedValue(false);
      const res = await request(buildApp('unknown@knauf.com')).get('/');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ allowed: false });
    });
  });

  describe('missing email', () => {
    it('returns 401 when req.user has no email', async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.user = {}; // no email field
        next();
      });
      app.use('/', migrationAccessRouter);

      const res = await request(app).get('/');
      expect(res.status).toBe(401);
      expect(mockIsEmailAllowed).not.toHaveBeenCalled();
    });

    it('returns 401 when req.user is undefined', async () => {
      const app = express();
      app.use(express.json());
      app.use('/', migrationAccessRouter);

      const res = await request(app).get('/');
      expect(res.status).toBe(401);
    });
  });

  describe('error handling', () => {
    it('returns 503 when isEmailAllowed throws', async () => {
      mockIsEmailAllowed.mockRejectedValue(new Error('DB timeout'));
      const res = await request(buildApp('ali@knauf.com')).get('/');
      expect(res.status).toBe(503);
      expect(res.body).toHaveProperty('message');
    });
  });

  describe('email normalisation', () => {
    it('passes the raw Okta email to isEmailAllowed (normalisation is the service\'s job)', async () => {
      mockIsEmailAllowed.mockResolvedValue(true);
      await request(buildApp('Ali.Karimizandi@Knauf.com')).get('/');
      expect(mockIsEmailAllowed).toHaveBeenCalledWith('Ali.Karimizandi@Knauf.com');
    });
  });
});
// End [knauf]
