// [knauf] KK20-204 — seam test: file_search retrieval resolves a deduped pointer to
// its canonical file_id before querying the RAG API (the pointer's own id has no
// vectors — they live under the canonical). See knauf/docs/proposals/file-dedup-content-hash.md.

jest.mock('axios');
jest.mock('@librechat/api', () => ({ generateShortLivedToken: jest.fn(() => 'jwt-token') }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.mock('~/server/services/Files/permissions', () => ({ filterFilesByAgentAccess: jest.fn() }));
jest.mock('~/models', () => ({ getFiles: jest.fn() }));

const axios = require('axios');
const { createFileSearchTool } = require('./fileSearch');

describe('fileSearch canonical resolution (KK20-204)', () => {
  const OLD_URL = process.env.RAG_API_URL;
  beforeAll(() => {
    process.env.RAG_API_URL = 'http://rag.test';
  });
  afterAll(() => {
    process.env.RAG_API_URL = OLD_URL;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    axios.post.mockResolvedValue({ data: [] });
  });

  test('queries the canonical file_id for a pointer, and the own id for a non-deduped file', async () => {
    const searchTool = await createFileSearchTool({
      userId: 'u1',
      entity_id: 'agentB',
      files: [
        { file_id: 'id2', filename: 'a.pdf', knauf_canonical_file_id: 'id1' }, // deduped pointer
        { file_id: 'plain', filename: 'b.pdf' }, // non-deduped
      ],
    });

    await searchTool.invoke({ query: 'hello' });

    const queriedIds = axios.post.mock.calls.map((call) => call[1].file_id).sort();
    expect(queriedIds).toEqual(['id1', 'plain']); // pointer resolved to id1 (NOT id2)
  });
});
// End [knauf]
