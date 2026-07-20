const { Readable } = require('stream');

jest.mock('axios');
jest.mock('@librechat/api', () => ({ generateShortLivedToken: jest.fn(() => 'rag-token') }));

const axios = require('axios');
const { createGenerationRagClient } = require('./generationRagClient');

describe('generation RAG client contract', () => {
  const originalRagUrl = process.env.RAG_API_URL;
  const getDownloadStream = jest.fn();
  const client = createGenerationRagClient({
    getStrategyFunctions: () => ({ getDownloadStream }),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAG_API_URL = 'http://rag.test';
    getDownloadStream.mockResolvedValue(Readable.from(['file contents']));
  });

  afterAll(() => {
    if (originalRagUrl === undefined) {
      delete process.env.RAG_API_URL;
    } else {
      process.env.RAG_API_URL = originalRagUrl;
    }
  });

  test('accepts only a complete matching generation', async () => {
    const ready = {
      status: 'ready',
      asset_id: 'asset-1',
      generation: 3,
      index_profile: 'profile-v1',
      chunks_expected: 12,
      chunks_written: 12,
    };
    axios.post.mockResolvedValue({ data: ready });

    await expect(
      client.embedGeneration({
        asset_id: 'asset-1',
        generation: 3,
        index_profile: 'profile-v1',
        embed_route: '/embed',
        blob: { source: 'azure_blob', path: 'asset-1', mime: 'text/plain' },
        scope: { userId: 'user-1', entityId: 'user-1' },
      }),
    ).resolves.toEqual(ready);

    expect(axios.post).toHaveBeenCalledWith(
      'http://rag.test/embed',
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer rag-token' }),
      }),
    );
  });

  test.each([
    [{ status: true }, 'legacy body-level success'],
    [
      {
        status: 'ready',
        asset_id: 'asset-1',
        generation: 3,
        index_profile: 'profile-v1',
        chunks_expected: 12,
        chunks_written: 11,
      },
      'partial chunk write',
    ],
  ])('rejects %s instead of activating it (%s)', async (data) => {
    axios.post.mockResolvedValue({ data });

    await expect(
      client.embedGeneration({
        asset_id: 'asset-1',
        generation: 3,
        index_profile: 'profile-v1',
        embed_route: '/embed',
        blob: { source: 'azure_blob', path: 'asset-1', mime: 'text/plain' },
        scope: { userId: 'user-1', entityId: 'user-1' },
      }),
    ).rejects.toMatchObject({ status: 502 });
  });

  test('scopes deletion to the asset backend', async () => {
    axios.delete.mockResolvedValue({ data: { status: 'deleted' } });

    await client.deleteGeneration({
      asset_id: 'asset-1',
      generation: 3,
      vector_backend: 'azure_search',
      userId: 'user-1',
    });

    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/generation',
      expect.objectContaining({
        data: { asset_id: 'asset-1', generation: 3, backend: 'azure_search' },
        headers: { Authorization: 'Bearer rag-token' },
      }),
    );
  });
});
