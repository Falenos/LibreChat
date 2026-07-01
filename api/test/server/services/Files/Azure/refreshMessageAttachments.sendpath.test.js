// [knauf] KK20-199 — Regression tests for the agent SEND-path SAS refresh.
// `AgentClient.buildMessages` (api/server/controllers/agents/client.js) calls
// `refreshMessageAttachmentUrls` on two surfaces before the outbound provider
// payload is built: the history `orderedMessages` and the current-turn
// `this.options.attachments` array — which is an array of MongoFile objects
// (not messages), so it is wrapped as `{ files: attachments }`. These tests
// pin that wrapping + in-place SAS rewrite so a reopened conversation no longer
// 403s ("Error while downloading file. Upstream status code: 403") on send.
// Instantiating the full AgentClient is too heavy, so we test at the exact
// seam the fix calls, mirroring `refreshMessageAttachments.test.js`.
// End [knauf]

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

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
  isAzureBlobUrl.mockReturnValue(true);
});

const STALE = 'https://acct.blob.core.windows.net/files/images/u/x?sig=OLD&se=2026-01-01T00:00:00Z';
const FRESH = 'https://acct.blob.core.windows.net/files/images/u/x?sig=NEW&se=2099-01-01T00:00:00Z';

describe('agent send-path SAS refresh (KK20-199)', () => {
  test('re-signs a stale SAS URL on a current-turn MongoFile attachment wrapped as { files }', async () => {
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockResolvedValue(FRESH);
    // Shape of `this.options.attachments`: an array of MongoFile objects.
    const attachments = [
      {
        file_id: 'f1',
        type: 'image/png',
        source: 'azure_blob',
        filepath: STALE,
        height: 10,
        width: 10,
      },
    ];
    await refreshMessageAttachmentUrls({ files: attachments });
    // Same object mutated in place -> flows into encodeAndFormat re-signed.
    expect(attachments[0].filepath).toBe(FRESH);
    expect(attachments[0].file_id).toBe('f1');
  });

  test('re-signs stale SAS URLs on history orderedMessages (files[] and attachments[])', async () => {
    needsRefreshAzure.mockReturnValue(true);
    getNewAzureURL.mockResolvedValue(FRESH);
    const orderedMessages = [
      { messageId: 'h1', files: [{ file_id: 'u1', source: 'azure_blob', filepath: STALE }] },
      { messageId: 'h2', attachments: [{ file_id: 'a1', source: 'azure_blob', filepath: STALE }] },
    ];
    await refreshMessageAttachmentUrls(orderedMessages);
    expect(orderedMessages[0].files[0].filepath).toBe(FRESH);
    expect(orderedMessages[1].attachments[0].filepath).toBe(FRESH);
  });

  test('leaves a fresh current-turn attachment untouched (no re-sign)', async () => {
    needsRefreshAzure.mockReturnValue(false);
    const attachments = [{ file_id: 'f1', source: 'azure_blob', filepath: FRESH }];
    await refreshMessageAttachmentUrls({ files: attachments });
    expect(attachments[0].filepath).toBe(FRESH);
    expect(needsRefreshAzure).toHaveBeenCalledTimes(1);
    expect(getNewAzureURL).not.toHaveBeenCalled();
  });

  test('leaves a non-Azure / local current-turn attachment untouched', async () => {
    isAzureBlobUrl.mockReturnValue(false);
    const attachments = [{ file_id: 'l1', source: 'local', filepath: '/uploads/u/x.png' }];
    await refreshMessageAttachmentUrls({ files: attachments });
    expect(attachments[0].filepath).toBe('/uploads/u/x.png');
    expect(needsRefreshAzure).not.toHaveBeenCalled();
  });

  test('empty current-turn attachments array is a safe no-op', async () => {
    const attachments = [];
    await refreshMessageAttachmentUrls({ files: attachments });
    expect(needsRefreshAzure).not.toHaveBeenCalled();
    expect(getNewAzureURL).not.toHaveBeenCalled();
  });
});
