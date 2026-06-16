// [knauf] KK20-182 — Integration test for the SAS refresh on
// `GET /api/messages/:conversationId` and `/:messageId`. Follows the
// supertest pattern in `messages-delete.spec.js`. See
// `knauf/docs/reference/azure-blob-storage.md` §7.1.
// End [knauf]

const express = require('express');
const request = require('supertest');

jest.mock('@librechat/api', () => ({
  unescapeLaTeX: jest.fn((x) => x),
  countTokens: jest.fn().mockResolvedValue(10),
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
  saveConvo: jest.fn(),
  getMessage: jest.fn(),
  saveMessage: jest.fn(),
  getMessages: jest.fn(),
  updateMessage: jest.fn(),
  deleteMessages: jest.fn(),
  getConvosQueried: jest.fn(),
  searchMessages: jest.fn(),
  getMessagesByCursor: jest.fn(),
}));

jest.mock('~/server/services/Artifacts/update', () => ({
  findAllArtifacts: jest.fn(),
  replaceArtifactContent: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    req.user = { id: 'u1' };
    next();
  },
  validateMessageReq: (req, res, next) => next(),
}));

// Mock the Azure crud primitives so we can pin needsRefresh / getNewURL.
jest.mock('~/server/services/Files/Azure/crud', () => ({
  needsRefreshAzure: jest.fn(),
  getNewAzureURL: jest.fn(),
  isAzureBlobUrl: jest.fn(),
}));

const db = require('~/models');
const {
  needsRefreshAzure,
  getNewAzureURL,
  isAzureBlobUrl,
} = require('~/server/services/Files/Azure/crud');

const router = require('../messages');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/messages', router);
  return app;
}

describe('GET /api/messages routes — KK20-182 SAS refresh', () => {
  const STALE = 'https://acct.blob.core.windows.net/files/images/u/x?sig=OLD&se=2026-01-01T00:00:00Z';
  const FRESH = 'https://acct.blob.core.windows.net/files/images/u/x?sig=NEW&se=2099-01-01T00:00:00Z';

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: pretend every URL in test fixtures is Azure-owned so the
    // pre-check in the shim falls through to the refresh decision below.
    isAzureBlobUrl.mockReturnValue(true);
  });

  test('GET /:conversationId rewrites stale SAS attachment URLs in place', async () => {
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockResolvedValue(FRESH);
    db.getMessages.mockResolvedValue([
      {
        messageId: 'm1',
        conversationId: 'c1',
        attachments: [
          { file_id: 'f1', filename: 'img.png', filepath: STALE },
        ],
      },
    ]);

    const res = await request(buildApp()).get('/api/messages/c1');

    expect(res.status).toBe(200);
    expect(res.body[0].attachments[0].filepath).toBe(FRESH);
    expect(res.body[0].attachments[0].file_id).toBe('f1');
  });

  test('GET /:conversationId rewrites stale SAS URLs in message.files[] (user uploads)', async () => {
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockResolvedValue(FRESH);
    db.getMessages.mockResolvedValue([
      {
        messageId: 'm1',
        conversationId: 'c1',
        files: [{ file_id: 'u1', filepath: STALE }],
      },
    ]);

    const res = await request(buildApp()).get('/api/messages/c1');

    expect(res.status).toBe(200);
    expect(res.body[0].files[0].filepath).toBe(FRESH);
  });

  test('GET /:conversationId/:messageId rewrites stale SAS attachment URLs', async () => {
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockResolvedValue(FRESH);
    db.getMessages.mockResolvedValue([
      {
        messageId: 'm1',
        conversationId: 'c1',
        attachments: [{ filepath: STALE }],
      },
    ]);

    const res = await request(buildApp()).get('/api/messages/c1/m1');

    expect(res.status).toBe(200);
    expect(res.body[0].attachments[0].filepath).toBe(FRESH);
  });

  test('non-Azure attachment URLs are left untouched', async () => {
    isAzureBlobUrl.mockReturnValue(false);
    db.getMessages.mockResolvedValue([
      {
        messageId: 'm1',
        conversationId: 'c1',
        attachments: [{ filepath: 'https://lh3.googleusercontent.com/x' }],
      },
    ]);

    const res = await request(buildApp()).get('/api/messages/c1');

    expect(res.status).toBe(200);
    expect(res.body[0].attachments[0].filepath).toBe('https://lh3.googleusercontent.com/x');
    expect(needsRefreshAzure).not.toHaveBeenCalled();
    expect(getNewAzureURL).not.toHaveBeenCalled();
  });

  test('local-path filepaths short-circuit before needsRefreshAzure', async () => {
    isAzureBlobUrl.mockReturnValue(false);
    db.getMessages.mockResolvedValue([
      {
        messageId: 'm1',
        conversationId: 'c1',
        attachments: [{ filepath: '/uploads/u/local-file.png' }],
      },
    ]);

    const res = await request(buildApp()).get('/api/messages/c1');

    expect(res.status).toBe(200);
    expect(res.body[0].attachments[0].filepath).toBe('/uploads/u/local-file.png');
    expect(needsRefreshAzure).not.toHaveBeenCalled();
  });

  test('messages without attachments pass through cleanly', async () => {
    db.getMessages.mockResolvedValue([
      { messageId: 'm1', conversationId: 'c1', text: 'hello' },
    ]);

    const res = await request(buildApp()).get('/api/messages/c1');

    expect(res.status).toBe(200);
    expect(res.body[0].text).toBe('hello');
    expect(needsRefreshAzure).not.toHaveBeenCalled();
  });
});
