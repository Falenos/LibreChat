jest.mock('~/cache/getLogStores');

const mockGetAppConfig = jest.fn();
jest.mock('~/server/services/Config/app', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/server/services/Config/ldap', () => ({
  getLdapConfig: jest.fn(() => null),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  getTenantId: () => undefined,
  logger: { warn: jest.fn() },
}));

const request = require('supertest');
const express = require('express');
const configRoute = require('../config');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api/config', configRoute);
  return app;
}

const baseAppConfig = {
  registration: { socialLogins: ['google'] },
  interfaceConfig: {},
};

afterEach(() => {
  jest.resetAllMocks();
  delete process.env.ANALYTICS_GTM_ID;
  delete process.env.KNAUF_ANALYTICS_ENABLED;
  delete process.env.KNAUF_ANALYTICS_ENV;
  delete process.env.KNAUF_ONETRUST_SCRIPT_SRC;
  delete process.env.KNAUF_ONETRUST_DOMAIN_SCRIPT_ID;
  delete process.env.KNAUF_ADOBE_ANALYTICS_SCRIPT_URL;
  delete process.env.KNAUF_ADOBE_APP_NAME;
  delete process.env.KNAUF_ANALYTICS_CONSENT_CATEGORY_ID;
});

describe('GET /api/config — Knauf analytics config', () => {
  it('includes consent-gated analytics config when Adobe Launch is configured', async () => {
    mockGetAppConfig.mockResolvedValue(baseAppConfig);
    process.env.KNAUF_ADOBE_ANALYTICS_SCRIPT_URL = 'https://example.test/adobe.js';
    const app = createApp();

    const response = await request(app).get('/api/config');

    expect(response.body.knauf.analytics).toEqual(
      expect.objectContaining({
        enabled: true,
        oneTrustDomainScriptId: '1f2c6fdd-5a57-44ad-b965-2a85d905bbdc-test',
        consentCategoryId: 'C0002',
        adobeLaunchScriptUrl: 'https://example.test/adobe.js',
        adobeAppName: 'knauf_agentic_karl',
      }),
    );
  });

  it('can be disabled explicitly', async () => {
    mockGetAppConfig.mockResolvedValue(baseAppConfig);
    process.env.KNAUF_ANALYTICS_ENABLED = 'false';
    const app = createApp();

    const response = await request(app).get('/api/config');

    expect(response.body).not.toHaveProperty('knauf');
  });

  it('suppresses legacy GTM when Knauf consent-gated analytics is active', async () => {
    mockGetAppConfig.mockResolvedValue(baseAppConfig);
    process.env.ANALYTICS_GTM_ID = 'GTM-123';
    process.env.KNAUF_ADOBE_ANALYTICS_SCRIPT_URL = 'https://example.test/adobe.js';
    const app = createApp();

    const response = await request(app).get('/api/config');

    expect(response.body.analyticsGtmId).toBeUndefined();
  });

  it('does not suppress legacy GTM when the Adobe Launch URL is not configured', async () => {
    mockGetAppConfig.mockResolvedValue(baseAppConfig);
    process.env.ANALYTICS_GTM_ID = 'GTM-123';
    const app = createApp();

    const response = await request(app).get('/api/config');

    expect(response.body.knauf).toBeUndefined();
    expect(response.body.analyticsGtmId).toBe('GTM-123');
  });
});
