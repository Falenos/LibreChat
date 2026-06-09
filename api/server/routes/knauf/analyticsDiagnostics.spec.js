const mockInfo = jest.fn();
const mockWarn = jest.fn();

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    req.user = { id: 'user-1', role: 'USER' };
    next();
  },
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: (...args) => mockInfo(...args),
    warn: (...args) => mockWarn(...args),
  },
}));

const express = require('express');
const request = require('supertest');

const router = require('./analyticsDiagnostics');
const { sanitizeDiagnosticPayload } = require('./analyticsDiagnostics');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/knauf/analytics', router);
  return app;
}

describe('Knauf analytics diagnostics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts valid diagnostic events and logs sanitized metadata only', async () => {
    const res = await request(makeApp())
      .post('/api/knauf/analytics/diagnostics')
      .send({
        event: 'adobe_launch_script_load_failed',
        scriptId: 'knauf-adobe-analytics',
        scriptHost: 'assets.adobedtm.com',
        scriptPath: '/ab43015a9bd1/launch.js?token=private',
        pagePath: '/c/sensitive-conversation-id?prompt=private',
        reason: 'x'.repeat(220),
        scriptUrl: 'https://assets.adobedtm.com/should-not-be-logged.js',
      });

    expect(res.status).toBe(204);
    expect(mockInfo).toHaveBeenCalledWith(
      {
        knaufAnalyticsDiagnostic: expect.objectContaining({
          event: 'adobe_launch_script_load_failed',
          scriptId: 'knauf-adobe-analytics',
          scriptHost: 'assets.adobedtm.com',
          scriptPath: '/ab43015a9bd1/launch.js',
          pagePath: '/c/:conversationId',
          reason: 'x'.repeat(160),
        }),
      },
      '[knauf analytics diagnostics] adobe_launch_script_load_failed',
    );
    expect(mockInfo.mock.calls[0][0].knaufAnalyticsDiagnostic).not.toHaveProperty('scriptUrl');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('rejects unknown diagnostic events', async () => {
    const res = await request(makeApp())
      .post('/api/knauf/analytics/diagnostics')
      .send({ event: 'raw_user_prompt_uploaded' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid analytics diagnostics payload.');
    expect(mockWarn).toHaveBeenCalledWith(
      '[knauf analytics diagnostics] Invalid diagnostic payload',
    );
    expect(mockInfo).not.toHaveBeenCalled();
  });

  it('normalizes known dynamic routes for diagnostics payloads', () => {
    expect(
      sanitizeDiagnosticPayload({
        event: 'adobe_data_layer_push_failed',
        pagePath: '/prompts/customer-specific-prompt',
      }),
    ).toEqual({
      event: 'adobe_data_layer_push_failed',
      pagePath: '/prompts/:promptId',
    });

    expect(
      sanitizeDiagnosticPayload({
        event: 'adobe_app_interaction_rejected',
        pagePath: '/agents/internal-category',
      }),
    ).toEqual({
      event: 'adobe_app_interaction_rejected',
      pagePath: '/agents/:category',
    });
  });
});
