// [knauf] KK20-182 — Unit tests for the message-attachment SAS refresh
// shim at `api/server/services/Files/Azure/refreshMessageAttachments.js`.
// Colocated with `crud.test.js` under `api/test/...` per the KK20-167
// precedent. See `knauf/docs/reference/azure-blob-storage.md` §7.1.
// End [knauf]

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

// [knauf] KK20-199 — assert refresh diagnostics contain neither SAS URLs nor errors.
const { logger } = require('@librechat/data-schemas');
// End [knauf]

jest.mock('../../../../../server/services/Files/Azure/crud', () => ({
  needsRefreshAzure: jest.fn(),
  getNewAzureURL: jest.fn(),
  isAzureBlobUrl: jest.fn(),
}));

const {
  needsRefreshAzure,
  getNewAzureURL,
  isAzureBlobUrl,
} = require('../../../../../server/services/Files/Azure/crud');
const {
  refreshMessageAttachmentUrls,
} = require('../../../../../server/services/Files/Azure/refreshMessageAttachments');

beforeEach(() => {
  jest.clearAllMocks();
  // The existing test fixtures all use Azure-shaped URLs, so default the
  // pre-check to true; tests that exercise the non-Azure path override.
  isAzureBlobUrl.mockReturnValue(true);
});

const FRESH =
  'https://acct.blob.core.windows.net/files/images/u/old?sig=OLD&se=2026-01-01T00:00:00Z';
const REFRESHED =
  'https://acct.blob.core.windows.net/files/images/u/old?sig=NEW&se=2099-01-01T00:00:00Z';

describe('refreshMessageAttachmentUrls', () => {
  test('returns input unchanged for null / undefined / []', async () => {
    expect(await refreshMessageAttachmentUrls(null)).toBeNull();
    expect(await refreshMessageAttachmentUrls(undefined)).toBeUndefined();
    const arr = [];
    expect(await refreshMessageAttachmentUrls(arr)).toBe(arr);
    expect(needsRefreshAzure).not.toHaveBeenCalled();
  });

  test('skips messages without attachments', async () => {
    const messages = [{ messageId: 'a' }, { messageId: 'b', attachments: undefined }];
    const result = await refreshMessageAttachmentUrls(messages);
    expect(result).toBe(messages);
    expect(needsRefreshAzure).not.toHaveBeenCalled();
  });

  test('passes through attachments whose filepath is not near expiry', async () => {
    needsRefreshAzure.mockReturnValue(false);
    const messages = [{ messageId: 'm1', attachments: [{ filepath: FRESH }] }];
    await refreshMessageAttachmentUrls(messages);
    expect(needsRefreshAzure).toHaveBeenCalledTimes(1);
    expect(getNewAzureURL).not.toHaveBeenCalled();
    expect(messages[0].attachments[0].filepath).toBe(FRESH);
  });

  test('rewrites filepath in place when near expiry', async () => {
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockResolvedValue(REFRESHED);
    const messages = [{ messageId: 'm1', attachments: [{ filepath: FRESH, file_id: 'f1' }] }];
    await refreshMessageAttachmentUrls(messages);
    expect(messages[0].attachments[0].filepath).toBe(REFRESHED);
    expect(messages[0].attachments[0].file_id).toBe('f1');
  });

  test('keeps original URL on getNewAzureURL error (no undefined leak)', async () => {
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockRejectedValue(new Error('boom'));
    const messages = [{ messageId: 'm1', attachments: [{ filepath: FRESH }] }];
    await refreshMessageAttachmentUrls(messages);
    expect(messages[0].attachments[0].filepath).toBe(FRESH);
    // [knauf] KK20-199 — the fallback keeps the URL in memory, never in telemetry.
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(FRESH);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('boom');
    // End [knauf]
  });

  test('keeps original URL when getNewAzureURL returns undefined', async () => {
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockResolvedValue(undefined);
    const messages = [{ messageId: 'm1', attachments: [{ filepath: FRESH }] }];
    await refreshMessageAttachmentUrls(messages);
    expect(messages[0].attachments[0].filepath).toBe(FRESH);
    // [knauf] KK20-199 — an empty refresh result also omits the SAS URL.
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(FRESH);
    // End [knauf]
  });

  test('tolerates attachments without filepath / null entries', async () => {
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockResolvedValue(REFRESHED);
    const messages = [
      {
        messageId: 'm1',
        attachments: [null, {}, { filepath: '' }, { filepath: FRESH }],
      },
    ];
    await refreshMessageAttachmentUrls(messages);
    expect(messages[0].attachments[3].filepath).toBe(REFRESHED);
    // only the one real filepath should have been checked
    expect(needsRefreshAzure).toHaveBeenCalledTimes(1);
  });

  test('memoizes resigning when the same filepath appears multiple times', async () => {
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockResolvedValue(REFRESHED);
    const messages = [
      {
        messageId: 'm1',
        attachments: [{ filepath: FRESH }, { filepath: FRESH }],
      },
      {
        messageId: 'm2',
        attachments: [{ filepath: FRESH }],
      },
    ];
    await refreshMessageAttachmentUrls(messages);
    expect(getNewAzureURL).toHaveBeenCalledTimes(1);
    expect(messages[0].attachments[0].filepath).toBe(REFRESHED);
    expect(messages[0].attachments[1].filepath).toBe(REFRESHED);
    expect(messages[1].attachments[0].filepath).toBe(REFRESHED);
  });

  test('accepts a single message (not wrapped in array)', async () => {
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockResolvedValue(REFRESHED);
    const message = { messageId: 'm1', attachments: [{ filepath: FRESH }] };
    const result = await refreshMessageAttachmentUrls(message);
    expect(result).toBe(message);
    expect(message.attachments[0].filepath).toBe(REFRESHED);
  });

  test('forwards bufferSeconds to needsRefreshAzure', async () => {
    needsRefreshAzure.mockReturnValue(false);
    const messages = [{ messageId: 'm1', attachments: [{ filepath: FRESH }] }];
    await refreshMessageAttachmentUrls(messages, { bufferSeconds: 42 });
    expect(needsRefreshAzure).toHaveBeenCalledWith(FRESH, 42);
  });

  test('non-Azure URLs are left untouched (isAzureBlobUrl returns false)', async () => {
    isAzureBlobUrl.mockReturnValue(false);
    const url = 'https://lh3.googleusercontent.com/a/avatar';
    const messages = [{ messageId: 'm1', attachments: [{ filepath: url }] }];
    await refreshMessageAttachmentUrls(messages);
    expect(messages[0].attachments[0].filepath).toBe(url);
    expect(needsRefreshAzure).not.toHaveBeenCalled();
    expect(getNewAzureURL).not.toHaveBeenCalled();
  });

  test('local-path filepaths short-circuit without calling Azure helpers', async () => {
    isAzureBlobUrl.mockReturnValue(false);
    const messages = [
      { messageId: 'm1', attachments: [{ filepath: '/uploads/u/local-file.png' }] },
    ];
    await refreshMessageAttachmentUrls(messages);
    expect(messages[0].attachments[0].filepath).toBe('/uploads/u/local-file.png');
    expect(needsRefreshAzure).not.toHaveBeenCalled();
  });

  test('attachment.source === "azure_blob" short-circuits the URL parse', async () => {
    // Simulate a CNAME'd custom endpoint that isAzureBlobUrl wouldn't catch
    // — the `source` field is enough to opt in.
    isAzureBlobUrl.mockReturnValue(false);
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockResolvedValue(REFRESHED);
    const messages = [
      {
        messageId: 'm1',
        attachments: [{ filepath: 'https://blobs.knauf.example/files/x', source: 'azure_blob' }],
      },
    ];
    await refreshMessageAttachmentUrls(messages);
    expect(messages[0].attachments[0].filepath).toBe(REFRESHED);
  });

  test('also walks message.files[] (user-uploaded files)', async () => {
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockResolvedValue(REFRESHED);
    const messages = [
      {
        messageId: 'm1',
        files: [{ file_id: 'u1', filepath: FRESH }],
        attachments: [{ file_id: 'a1', filepath: FRESH }],
      },
    ];
    await refreshMessageAttachmentUrls(messages);
    expect(messages[0].files[0].filepath).toBe(REFRESHED);
    expect(messages[0].attachments[0].filepath).toBe(REFRESHED);
    // Cache key is `filepath` — same URL in both fields shares one resign.
    expect(getNewAzureURL).toHaveBeenCalledTimes(1);
  });

  test('refreshes message.files[] even when attachments is absent', async () => {
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockResolvedValue(REFRESHED);
    const messages = [{ messageId: 'm1', files: [{ filepath: FRESH }] }];
    await refreshMessageAttachmentUrls(messages);
    expect(messages[0].files[0].filepath).toBe(REFRESHED);
  });
});
