// [knauf] KK20-182 — Integration test for the SAS refresh on
// `GET /api/share/:shareId`. Follows the same supertest pattern as
// `messages.knauf.spec.js`. See `knauf/docs/reference/azure-blob-storage.md` §7.1.
// End [knauf]

const express = require('express');
const request = require('supertest');

jest.mock('@librechat/api', () => ({
  isEnabled: (v) => v === undefined || v === true || v === 'true',
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
  getSharedMessages: jest.fn(),
  createSharedLink: jest.fn(),
  updateSharedLink: jest.fn(),
  deleteSharedLink: jest.fn(),
  getSharedLinks: jest.fn(),
  getSharedLink: jest.fn(),
}));

jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => {
  req.user = { id: 'u1' };
  next();
});

jest.mock('~/server/services/Files/Azure/crud', () => ({
  needsRefreshAzure: jest.fn(),
  getNewAzureURL: jest.fn(),
  isAzureBlobUrl: jest.fn(),
}));

const { getSharedMessages } = require('~/models');
const {
  needsRefreshAzure,
  getNewAzureURL,
  isAzureBlobUrl,
} = require('~/server/services/Files/Azure/crud');

// Force ALLOW_SHARED_LINKS_PUBLIC unset so the router uses our mocked JWT
// middleware (and gives us a `req.user`).
delete process.env.ALLOW_SHARED_LINKS_PUBLIC;
const router = require('../share');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/share', router);
  return app;
}

describe('GET /api/share/:shareId — KK20-182 SAS refresh', () => {
  const STALE = 'https://acct.blob.core.windows.net/files/images/u/x?sig=OLD&se=2026-01-01T00:00:00Z';
  const FRESH = 'https://acct.blob.core.windows.net/files/images/u/x?sig=NEW&se=2099-01-01T00:00:00Z';

  beforeEach(() => {
    jest.clearAllMocks();
    isAzureBlobUrl.mockReturnValue(true);
  });

  test('rewrites stale SAS URLs in shared conversation attachments', async () => {
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockResolvedValue(FRESH);
    getSharedMessages.mockResolvedValue({
      shareId: 's1',
      title: 't',
      conversationId: 'anon-c1',
      messages: [
        {
          messageId: 'm1',
          attachments: [{ filepath: STALE }],
          files: [{ filepath: STALE }],
        },
      ],
    });

    const res = await request(buildApp()).get('/api/share/s1');

    expect(res.status).toBe(200);
    expect(res.body.messages[0].attachments[0].filepath).toBe(FRESH);
    expect(res.body.messages[0].files[0].filepath).toBe(FRESH);
    // Same blob path appears twice — cache dedupes to one resign.
    expect(getNewAzureURL).toHaveBeenCalledTimes(1);
  });

  test('returns 404 when getSharedMessages returns null', async () => {
    getSharedMessages.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/share/missing');
    expect(res.status).toBe(404);
    expect(getNewAzureURL).not.toHaveBeenCalled();
  });
});
