// [knauf] KK20-203 — seam test for the hardened, batched pgvector delete used by
// the chat-delete cascade (cascadeDeleteConvoFiles). Asserts bounded retry on
// transient failures, 404-as-success idempotency, and fail-fast on a 4xx.

jest.mock('axios');
jest.mock('@librechat/api', () => ({
  logAxiosError: jest.fn(),
  generateShortLivedToken: jest.fn(() => 'jwt-token'),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const axios = require('axios');
const { deleteVectorsByIds, deleteVectorsForFiles } = require('./crud');

describe('deleteVectorsByIds (KK20-203)', () => {
  const OLD_URL = process.env.RAG_API_URL;
  const req = { user: { id: 'u1' } };

  beforeAll(() => {
    process.env.RAG_API_URL = 'http://rag.test';
  });
  afterAll(() => {
    if (OLD_URL === undefined) {
      delete process.env.RAG_API_URL;
    } else {
      process.env.RAG_API_URL = OLD_URL;
    }
  });
  beforeEach(() => jest.clearAllMocks());

  test('posts the batch of ids to /documents in one call', async () => {
    axios.delete.mockResolvedValue({ status: 200 });
    await deleteVectorsByIds(req, ['a', 'b']);
    expect(axios.delete).toHaveBeenCalledTimes(1);
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['a', 'b'] }),
    );
  });

  test('is a no-op (no RAG call) for an empty id list', async () => {
    await deleteVectorsByIds(req, []);
    expect(axios.delete).not.toHaveBeenCalled();
  });

  test('filters falsy ids before deciding to call', async () => {
    await deleteVectorsByIds(req, [null, undefined, '']);
    expect(axios.delete).not.toHaveBeenCalled();
  });

  test('treats 404 as idempotent success and does not throw', async () => {
    axios.delete.mockRejectedValue({ response: { status: 404 } });
    await expect(deleteVectorsByIds(req, ['x'])).resolves.toBeUndefined();
    expect(axios.delete).toHaveBeenCalledTimes(1);
  });

  test('retries a transient 5xx and throws after the attempt budget', async () => {
    axios.delete.mockRejectedValue({ response: { status: 503 }, message: 'unavailable' });
    await expect(deleteVectorsByIds(req, ['x'])).rejects.toThrow();
    expect(axios.delete).toHaveBeenCalledTimes(3);
  });

  test('fails fast on a non-transient 4xx (no retry)', async () => {
    axios.delete.mockRejectedValue({ response: { status: 400 }, message: 'bad request' });
    await expect(deleteVectorsByIds(req, ['x'])).rejects.toThrow();
    expect(axios.delete).toHaveBeenCalledTimes(1);
  });
});

// [knauf] Seam test for Azure-Search-aware batch delete.
describe('deleteVectorsForFiles (Azure Search routing)', () => {
  const OLD_URL = process.env.RAG_API_URL;
  const OLD_SEARCH = process.env.AZURE_SEARCH_ENABLED;
  const req = { user: { id: 'u1' } };

  beforeAll(() => {
    process.env.RAG_API_URL = 'http://rag.test';
  });
  afterAll(() => {
    process.env.RAG_API_URL = OLD_URL;
    if (OLD_SEARCH === undefined) {
      delete process.env.AZURE_SEARCH_ENABLED;
    } else {
      process.env.AZURE_SEARCH_ENABLED = OLD_SEARCH;
    }
  });
  beforeEach(() => jest.clearAllMocks());

  test('deletes from BOTH Azure Search and pgvector when Azure Search enabled', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectorsForFiles(req, [
      { file_id: 'agent-file-1', context: 'agents' },
      { file_id: 'agent-file-2', context: 'agents' },
    ]);

    // Azure Search per-file deletes
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/agent-file-1',
      expect.any(Object),
    );
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/agent-file-2',
      expect.any(Object),
    );
    // ALSO pgvector batch (idempotent fallback)
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['agent-file-1', 'agent-file-2'] }),
    );
  });

  test('deletes message_attachment files from BOTH stores when Azure Search enabled', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockResolvedValue({ status: 200 });

    // Chat file_search attachments have context: message_attachment but were
    // uploaded to Azure Search via entity_id — both stores must be tried.
    await deleteVectorsForFiles(req, [
      { file_id: 'chat-file-1', context: 'message_attachment' },
    ]);

    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/chat-file-1',
      expect.any(Object),
    );
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['chat-file-1'] }),
    );
  });

  test('handles mixed files — all go to both stores', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectorsForFiles(req, [
      { file_id: 'agent-1', context: 'agents' },
      { file_id: 'chat-1', context: 'message_attachment' },
      { file_id: 'chat-2', context: 'message_attachment' },
    ]);

    // 3 Azure Search per-file + 1 pgvector batch = 4
    expect(axios.delete).toHaveBeenCalledTimes(4);
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/agent-1',
      expect.any(Object),
    );
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/chat-1',
      expect.any(Object),
    );
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/chat-2',
      expect.any(Object),
    );
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['agent-1', 'chat-1', 'chat-2'] }),
    );
  });

  test('falls back to pgvector only when Azure Search disabled', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'false';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectorsForFiles(req, [
      { file_id: 'agent-1', context: 'agents' },
      { file_id: 'chat-1', context: 'message_attachment' },
    ]);

    expect(axios.delete).toHaveBeenCalledTimes(1);
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['agent-1', 'chat-1'] }),
    );
  });

  test('skips files with missing file_id', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectorsForFiles(req, [
      { file_id: 'good-1', context: 'agents' },
      { file_id: undefined, context: 'agents' },
      { file_id: null, context: 'message_attachment' },
    ]);

    // Only good-1 should hit Azure Search + pgvector
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/good-1',
      expect.any(Object),
    );
    expect(axios.delete).not.toHaveBeenCalledWith(
      expect.stringContaining('/agent/documents/undefined'),
      expect.any(Object),
    );
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['good-1'] }),
    );
  });

  test('is a no-op for empty file list', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    await deleteVectorsForFiles(req, []);
    expect(axios.delete).not.toHaveBeenCalled();
  });
});
// End [knauf]
