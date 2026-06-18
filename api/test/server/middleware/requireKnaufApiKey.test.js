// [knauf] Tests for requireKnaufApiKey middleware.
'use strict';

const createRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe('requireKnaufApiKey middleware', () => {
  const VALID_SECRET = 'test-secret-abc';

  beforeEach(() => {
    process.env.KNAUF_MIGRATION_API_SECRET = VALID_SECRET;
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.KNAUF_MIGRATION_API_SECRET;
  });

  const load = () => require('~/server/middleware/requireKnaufApiKey');

  it('calls next() when the correct key is provided', async () => {
    const middleware = load();
    const next = jest.fn();
    await middleware({ headers: { 'x-knauf-api-key': VALID_SECRET } }, createRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('returns 401 when header is missing', async () => {
    const middleware = load();
    const next = jest.fn();
    const res = createRes();
    await middleware({ headers: {} }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 401 when header value is wrong', async () => {
    const middleware = load();
    const next = jest.fn();
    const res = createRes();
    await middleware({ headers: { 'x-knauf-api-key': 'wrong' } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 500 when KNAUF_MIGRATION_API_SECRET is not set', async () => {
    delete process.env.KNAUF_MIGRATION_API_SECRET;
    const middleware = load();
    const next = jest.fn();
    const res = createRes();
    await middleware({ headers: { 'x-knauf-api-key': 'any' } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
// End [knauf]
