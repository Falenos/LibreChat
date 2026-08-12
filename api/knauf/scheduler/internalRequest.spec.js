'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  createSchedulerFireMiddleware,
  createSchedulerRequestHeaders,
  exemptSchedulerIpLimiter,
  exemptSchedulerUserLimiter,
  verifySchedulerRequest,
} = require('./internalRequest');

const createRequest = ({
  headers,
  userId = 'user-1',
  method = 'POST',
  url = '/api/agents/chat/agents',
}) => ({
  get: (name) => headers[name] ?? headers[name.toLowerCase()],
  method,
  originalUrl: url,
  user: { id: userId },
});

describe('scheduler internal request identity', () => {
  test('verifies automatic fires and applies scoped limiter exemptions', () => {
    const headers = createSchedulerRequestHeaders({
      secret: 'test-secret',
      userId: 'user-1',
      trigger: 'automatic',
      method: 'POST',
      path: '/api/agents/chat/agents',
      now: () => 1_700_000_000_000,
    });
    const req = createRequest({ headers });
    req.knaufSchedulerFire = verifySchedulerRequest(req, {
      secret: 'test-secret',
      now: () => 1_700_000_000_000,
    });

    expect(req.knaufSchedulerFire).toEqual({ trigger: 'automatic' });
    expect(exemptSchedulerIpLimiter(req)).toBe(true);
    expect(exemptSchedulerUserLimiter(req)).toBe(true);
  });

  test('manual fires bypass worker IP limiting but retain user limiting', () => {
    const req = { knaufSchedulerFire: { trigger: 'manual' } };
    expect(exemptSchedulerIpLimiter(req)).toBe(true);
    expect(exemptSchedulerUserLimiter(req)).toBe(false);
  });

  test('rejects a forged scheduler identity', async () => {
    const req = createRequest({
      headers: {
        'x-knauf-scheduler-signature': '00',
        'x-knauf-scheduler-timestamp': String(Date.now()),
        'x-knauf-scheduler-trigger': 'automatic',
      },
    });
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    await createSchedulerFireMiddleware({ getSecret: () => 'test-secret' })(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('holds start admission until generation job registration', async () => {
    const headers = createSchedulerRequestHeaders({
      secret: 'test-secret',
      userId: 'user-1',
      trigger: 'automatic',
      method: 'POST',
      path: '/api/agents/chat/agents',
    });
    const req = createRequest({ headers });
    req.body = {};
    const res = Object.assign(new EventEmitter(), {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    });
    const release = jest.fn().mockResolvedValue();
    const next = jest.fn();

    await createSchedulerFireMiddleware({
      getSecret: () => 'test-secret',
      admitUserRequest: jest.fn().mockResolvedValue(release),
    })(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.knaufSchedulerAdmissionRelease).toBe(release);
    res.emit('finish');
    await new Promise(setImmediate);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('keeps the agent route seam wired to verification and limiter exemptions', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../server/routes/agents/index.js'),
      'utf8',
    );
    expect(source).toContain('createSchedulerFireMiddleware');
    expect(source).toContain('unless(exemptSchedulerIpLimiter, messageIpLimiter)');
    expect(source).toContain('unless(exemptSchedulerUserLimiter, messageUserLimiter)');
  });
});
