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
const { deleteVectorsByIds } = require('./crud');

describe('deleteVectorsByIds (KK20-203)', () => {
  const OLD_URL = process.env.RAG_API_URL;
  const req = { user: { id: 'u1' } };

  beforeAll(() => {
    process.env.RAG_API_URL = 'http://rag.test';
  });
  afterAll(() => {
    process.env.RAG_API_URL = OLD_URL;
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
// End [knauf]
