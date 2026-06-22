// [knauf] Tests for migration access routes.
'use strict';

const express = require('express');
const request = require('supertest');

const mockIsEmailAllowed = jest.fn();

jest.mock('~/server/knauf/migrationAllowlist', () => ({
  isEmailAllowed: mockIsEmailAllowed,
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
}));

const VALID_SECRET = 'test-secret-123';

// Snapshot env once before all tests; restore fully after each test so no
// state leaks between suites when running with jest -t or --testPathPatterns.
const originalEnv = { ...process.env };
afterEach(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

const buildApp = () => {
  process.env.KNAUF_MIGRATION_API_SECRET = VALID_SECRET;
  jest.resetModules();
  // Re-mock after resetModules
  jest.mock('~/server/knauf/migrationAllowlist', () => ({ isEmailAllowed: mockIsEmailAllowed }));
  jest.mock('~/server/middleware', () => ({ requireJwtAuth: (req, res, next) => next() }));
  const router = require('~/server/routes/knauf/migrationAccess');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { email: 'ali@knauf.com' }; next(); });
  app.use('/', router);
  return app;
};

describe('GET / — frontend endpoint (JWT)', () => {
  beforeEach(() => {
    process.env.MIGRATION_ALLOWLIST_ENABLED = 'true';
    mockIsEmailAllowed.mockClear();
  });

  it('returns { allowed: true } for an allowed user', async () => {
    mockIsEmailAllowed.mockResolvedValue(true);
    const app = buildApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: true });
  });

  it('returns { allowed: false } for a non-allowed user', async () => {
    mockIsEmailAllowed.mockResolvedValue(false);
    const app = buildApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: false });
  });

  it('returns 503 when isEmailAllowed throws', async () => {
    mockIsEmailAllowed.mockRejectedValue(new Error('DB timeout'));
    const app = buildApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(503);
  });
});

describe('GET /check — third-party endpoint (API key)', () => {
  beforeEach(() => {
    process.env.MIGRATION_ALLOWLIST_ENABLED = 'true';
    process.env.KNAUF_MIGRATION_API_SECRET = VALID_SECRET;
    mockIsEmailAllowed.mockClear();
  });

  it('returns { allowed: true } with valid key and allowed email', async () => {
    mockIsEmailAllowed.mockResolvedValue(true);
    const app = buildApp();
    const res = await request(app)
      .get('/check?email=ali@knauf.com')
      .set('X-Knauf-Api-Key', VALID_SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: true });
  });

  it('returns 401 when API key is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/check?email=ali@knauf.com');
    expect(res.status).toBe(401);
  });

  it('returns 401 when API key is wrong', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/check?email=ali@knauf.com')
      .set('X-Knauf-Api-Key', 'wrong');
    expect(res.status).toBe(401);
  });

  it('returns 400 when email is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/check').set('X-Knauf-Api-Key', VALID_SECRET);
    expect(res.status).toBe(400);
    expect(mockIsEmailAllowed).not.toHaveBeenCalled();
  });

  it('passes trimmed email to isEmailAllowed', async () => {
    mockIsEmailAllowed.mockResolvedValue(true);
    const app = buildApp();
    await request(app)
      .get('/check?email=  ali@knauf.com  ')
      .set('X-Knauf-Api-Key', VALID_SECRET);
    expect(mockIsEmailAllowed).toHaveBeenCalledWith('ali@knauf.com');
  });

  it('returns 503 when isEmailAllowed throws', async () => {
    mockIsEmailAllowed.mockRejectedValue(new Error('DB timeout'));
    const app = buildApp();
    const res = await request(app)
      .get('/check?email=ali@knauf.com')
      .set('X-Knauf-Api-Key', VALID_SECRET);
    expect(res.status).toBe(503);
  });
});

describe('MIGRATION_ALLOWLIST_ENABLED=false — gate disabled', () => {
  beforeEach(() => {
    process.env.MIGRATION_ALLOWLIST_ENABLED = 'false';
    process.env.KNAUF_MIGRATION_API_SECRET = VALID_SECRET;
    mockIsEmailAllowed.mockClear();
  });

  it('frontend endpoint returns { allowed: true } without DB call', async () => {
    const app = buildApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: true });
    expect(mockIsEmailAllowed).not.toHaveBeenCalled();
  });

  it('third-party endpoint always checks allowlist even when gate is disabled — allowed email', async () => {
    mockIsEmailAllowed.mockResolvedValue(true);
    const app = buildApp();
    const res = await request(app)
      .get('/check?email=ali@knauf.com')
      .set('X-Knauf-Api-Key', VALID_SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: true });
    expect(mockIsEmailAllowed).toHaveBeenCalledWith('ali@knauf.com');
  });

  it('third-party endpoint always checks allowlist even when gate is disabled — denied email', async () => {
    mockIsEmailAllowed.mockResolvedValue(false);
    const app = buildApp();
    const res = await request(app)
      .get('/check?email=stranger@example.com')
      .set('X-Knauf-Api-Key', VALID_SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: false });
    expect(mockIsEmailAllowed).toHaveBeenCalledWith('stranger@example.com');
  });
});
// End [knauf]
