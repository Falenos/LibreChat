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
    if (OLD_URL === undefined) {
      delete process.env.RAG_API_URL;
    } else {
      process.env.RAG_API_URL = OLD_URL;
    }
    if (OLD_SEARCH === undefined) {
      delete process.env.AZURE_SEARCH_ENABLED;
    } else {
      process.env.AZURE_SEARCH_ENABLED = OLD_SEARCH;
    }
  });
  beforeEach(() => jest.clearAllMocks());

  test('agent files go to Azure Search when enabled', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectorsForFiles(req, [
      { file_id: 'agent-file-1', context: 'agents' },
      { file_id: 'agent-file-2', context: 'agents' },
    ]);

    // Agent files → Azure Search only, no pgvector
    expect(axios.delete).toHaveBeenCalledTimes(2);
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/agent-file-1',
      expect.any(Object),
    );
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/agent-file-2',
      expect.any(Object),
    );
  });

  test('chat/message_attachment files go to pgvector even when Azure Search enabled', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectorsForFiles(req, [
      { file_id: 'chat-file-1', context: 'message_attachment' },
    ]);

    // Chat files always go to pgvector, never Azure Search
    expect(axios.delete).toHaveBeenCalledTimes(1);
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['chat-file-1'] }),
    );
  });

  test('mixed batch — agent files to Azure Search, chat files to pgvector', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectorsForFiles(req, [
      { file_id: 'agent-1', context: 'agents' },
      { file_id: 'chat-1', context: 'message_attachment' },
      { file_id: 'chat-2', context: 'message_attachment' },
    ]);

    // 1 Azure Search for agent + 1 pgvector batch for chats = 2
    expect(axios.delete).toHaveBeenCalledTimes(2);
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/agent-1',
      expect.any(Object),
    );
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['chat-1', 'chat-2'] }),
    );
  });

  test('all files go to pgvector when Azure Search disabled', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'false';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectorsForFiles(req, [
      { file_id: 'agent-1', context: 'agents' },
      { file_id: 'chat-1', context: 'message_attachment' },
    ]);

    // All to pgvector when Azure Search disabled
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

    // Only good-1 (agent) hits Azure Search; null/undefined filtered out
    expect(axios.delete).toHaveBeenCalledTimes(1);
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/good-1',
      expect.any(Object),
    );
  });

  test('is a no-op for empty file list', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    await deleteVectorsForFiles(req, []);
    expect(axios.delete).not.toHaveBeenCalled();
  });

  // [knauf] Azure-failure branch — pinning the round-2/round-3 semantics: pgvector
  // runs first and unconditionally, an Azure failure aggregate-throws with the
  // failed ids afterward, and a 404 on /agent/documents/:id is swallowed as success.
  test('mixed batch: pgvector still runs and succeeds even when an Azure delete fails', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockImplementation((url) => {
      if (url === 'http://rag.test/documents') {
        return Promise.resolve({ status: 200 });
      }
      if (url.endsWith('/agent-fail')) {
        return Promise.reject({ response: { status: 400 }, message: 'bad request' });
      }
      return Promise.resolve({ status: 200 });
    });

    await expect(
      deleteVectorsForFiles(req, [
        { file_id: 'agent-fail', context: 'agents' },
        { file_id: 'chat-1', context: 'message_attachment' },
      ]),
    ).rejects.toThrow(/agent-fail/);

    // pgvector call for the chat file happened despite the Azure failure.
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['chat-1'] }),
    );
  });

  test('aggregate-throws listing every failed agent file id', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockImplementation((url) => {
      if (url.endsWith('/agent-ok')) {
        return Promise.resolve({ status: 200 });
      }
      return Promise.reject({ response: { status: 400 }, message: 'bad request' });
    });

    await expect(
      deleteVectorsForFiles(req, [
        { file_id: 'agent-ok', context: 'agents' },
        { file_id: 'agent-bad-1', context: 'agents' },
        { file_id: 'agent-bad-2', context: 'agents' },
      ]),
    ).rejects.toThrow(/agent-bad-1.*agent-bad-2|agent-bad-2.*agent-bad-1/);
  });

  test('a 404 on /agent/documents/:id resolves silently (no throw)', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockRejectedValue({ response: { status: 404 } });

    await expect(
      deleteVectorsForFiles(req, [{ file_id: 'agent-gone', context: 'agents' }]),
    ).resolves.toBeUndefined();
  });

  test('chunks agent deletes into waves of AZURE_SEARCH_CONCURRENCY (5), sequentially', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    let inFlight = 0;
    let maxInFlight = 0;
    axios.delete.mockImplementation(() => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) =>
        setTimeout(() => {
          inFlight--;
          resolve({ status: 200 });
        }, 5),
      );
    });

    const files = Array.from({ length: 7 }, (_, i) => ({
      file_id: `agent-${i}`,
      context: 'agents',
    }));
    await deleteVectorsForFiles(req, files);

    expect(axios.delete).toHaveBeenCalledTimes(7);
    // Wave 1 = 5 concurrent, wave 2 = 2 — never all 7 at once.
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });
  // End [knauf]
});
// End [knauf]
