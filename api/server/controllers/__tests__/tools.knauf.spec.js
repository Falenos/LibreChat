// [knauf] KK20-182 — Integration test for the SAS refresh on
// `GET /api/agents/tools/calls`. Code-interpreter / execute_code artifacts
// rehydrated through `useToolCallsMap` had the same 5-min SAS decay as
// message attachments. See `knauf/docs/reference/azure-blob-storage.md` §7.1.
// End [knauf]

const express = require('express');
const request = require('supertest');

jest.mock('@librechat/api', () => ({
  checkAccess: jest.fn().mockResolvedValue(true),
  loadWebSearchAuth: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('~/models', () => ({
  getRoleByName: jest.fn(),
  createToolCall: jest.fn(),
  getToolCallsByConvo: jest.fn(),
  getMessage: jest.fn(),
}));

jest.mock('~/server/services/Files/process', () => ({
  processFileURL: jest.fn(),
  uploadImageBuffer: jest.fn(),
}));

jest.mock('~/server/services/Files/Code/process', () => ({
  processCodeOutput: jest.fn(),
}));

jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: jest.fn(),
}));

jest.mock('~/app/clients/tools/util', () => ({
  loadTools: jest.fn(),
}));

jest.mock('~/server/services/Files/Azure/crud', () => ({
  needsRefreshAzure: jest.fn(),
  getNewAzureURL: jest.fn(),
  isAzureBlobUrl: jest.fn(),
}));

const { getToolCallsByConvo } = require('~/models');
const {
  needsRefreshAzure,
  getNewAzureURL,
  isAzureBlobUrl,
} = require('~/server/services/Files/Azure/crud');
const { getToolCalls } = require('../tools');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/agents/tools/calls', (req, res, next) => {
    req.user = { id: 'u1' };
    return getToolCalls(req, res, next);
  });
  return app;
}

describe('GET /api/agents/tools/calls — KK20-182 SAS refresh', () => {
  const STALE = 'https://acct.blob.core.windows.net/files/images/u/x?sig=OLD&se=2026-01-01T00:00:00Z';
  const FRESH = 'https://acct.blob.core.windows.net/files/images/u/x?sig=NEW&se=2099-01-01T00:00:00Z';

  beforeEach(() => {
    jest.clearAllMocks();
    isAzureBlobUrl.mockReturnValue(true);
  });

  test('rewrites stale SAS URLs in toolcalls[].attachments[]', async () => {
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockResolvedValue(FRESH);
    getToolCallsByConvo.mockResolvedValue([
      {
        conversationId: 'c1',
        messageId: 'm1',
        toolId: 'execute_code',
        attachments: [{ file_id: 'tc1', filepath: STALE }],
      },
    ]);

    const res = await request(buildApp()).get('/api/agents/tools/calls?conversationId=c1');

    expect(res.status).toBe(200);
    expect(res.body[0].attachments[0].filepath).toBe(FRESH);
    expect(res.body[0].attachments[0].file_id).toBe('tc1');
  });

  test('toolcalls without attachments pass through cleanly', async () => {
    getToolCallsByConvo.mockResolvedValue([
      { conversationId: 'c1', messageId: 'm1', toolId: 'web_search', result: {} },
    ]);

    const res = await request(buildApp()).get('/api/agents/tools/calls?conversationId=c1');

    expect(res.status).toBe(200);
    expect(needsRefreshAzure).not.toHaveBeenCalled();
  });
});
