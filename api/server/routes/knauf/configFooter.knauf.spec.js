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
  getTenantId: jest.fn(() => undefined),
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
  registration: {},
  interfaceConfig: {},
};

describe('[knauf] GET /api/config Knauf brand defaults', () => {
  afterEach(() => {
    jest.resetAllMocks();
    delete process.env.APP_TITLE;
    delete process.env.CUSTOM_FOOTER;
    delete process.env.HELP_AND_FAQ_URL;
  });

  it('defaults startup brand fields to Agentic Karl when env overrides are unset', async () => {
    mockGetAppConfig.mockResolvedValue(baseAppConfig);

    const response = await request(createApp()).get('/api/config');

    expect(response.statusCode).toBe(200);
    expect(response.body.appTitle).toBe('Agentic Karl | Knauf AI Platform');
    expect(response.body.customFooter).toBe('Agentic Karl | Knauf AI Platform');
    expect(response.body.helpAndFaqURL).toBe('/');
  });

  it('honors env overrides when deployments provide them', async () => {
    process.env.APP_TITLE = 'Custom title';
    process.env.CUSTOM_FOOTER = 'Custom footer';
    process.env.HELP_AND_FAQ_URL = 'https://help.example.com';
    mockGetAppConfig.mockResolvedValue(baseAppConfig);

    const response = await request(createApp()).get('/api/config');

    expect(response.statusCode).toBe(200);
    expect(response.body.appTitle).toBe('Custom title');
    expect(response.body.customFooter).toBe('Custom footer');
    expect(response.body.helpAndFaqURL).toBe('https://help.example.com');
  });
});
