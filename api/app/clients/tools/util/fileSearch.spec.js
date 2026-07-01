// [knauf] KK20-204 — seam test: file_search retrieval resolves a deduped reuse row to
// its shared asset id before querying the RAG API (the row's own id has no vectors —
// they live under knauf_asset_id). See knauf/docs/proposals/file-dedup-content-hash.md.

jest.mock('axios');
jest.mock('@librechat/api', () => ({ generateShortLivedToken: jest.fn(() => 'jwt-token') }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.mock('~/server/services/Files/permissions', () => ({ filterFilesByAgentAccess: jest.fn() }));
jest.mock('~/models', () => ({ getFiles: jest.fn() }));

const axios = require('axios');
const { createFileSearchTool } = require('./fileSearch');

describe('fileSearch asset-id resolution (KK20-204)', () => {
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

  test('queries the shared asset id for a reuse row, and the own id for a non-deduped file', async () => {
    const searchTool = await createFileSearchTool({
      userId: 'u1',
      entity_id: 'agentB',
      files: [
        { file_id: 'id2', filename: 'a.pdf', knauf_asset_id: 'id1' }, // deduped reuse row → asset id
        { file_id: 'plain', filename: 'b.pdf' }, // agent-library / non-deduped row → own file_id
      ],
    });

    await searchTool.invoke({ query: 'hello' });

    const queriedIds = axios.post.mock.calls.map((call) => call[1].file_id).sort();
    expect(queriedIds).toEqual(['id1', 'plain']); // reuse row resolved to id1 (NOT id2)
  });
});
// End [knauf]
