// [knauf] KK20-204 — seam test: file_search retrieval resolves a deduped reuse row to
// its shared asset id before querying the RAG API (the row's own id has no vectors —
// they live under knauf_asset_id). See knauf/docs/proposals/file-dedup-content-hash.md.

jest.mock('axios');
jest.mock('@librechat/api', () => ({ generateShortLivedToken: jest.fn(() => 'jwt-token') }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.mock('~/server/services/Files/permissions', () => ({ filterFilesByAgentAccess: jest.fn() }));
jest.mock('~/models', () => ({ getFiles: jest.fn(), getAssetsByAssetIds: jest.fn() }));

const axios = require('axios');
const { createFileSearchTool, primeFiles } = require('./fileSearch');

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

// [knauf] KK20-203 — seam test: per-file query URL routing. Agent-context files
// query Azure AI Search (`/agent/query`) only when AZURE_SEARCH_ENABLED is true;
// chat/message-attachment files always query pgvector (`/query`), regardless of
// the flag.
describe('fileSearch query routing (KK20-203)', () => {
  const OLD_URL = process.env.RAG_API_URL;
  const OLD_SEARCH = process.env.AZURE_SEARCH_ENABLED;
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
  beforeEach(() => {
    jest.clearAllMocks();
    axios.post.mockResolvedValue({ data: [] });
  });

  test('agent-context files query /agent/query when Azure Search is enabled', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    const searchTool = await createFileSearchTool({
      userId: 'u1',
      files: [{ file_id: 'agent-1', filename: 'a.pdf', context: 'agents' }],
    });

    await searchTool.invoke({ query: 'hello' });

    expect(axios.post).toHaveBeenCalledWith(
      'http://rag.test/agent/query',
      expect.objectContaining({ file_id: 'agent-1' }),
      expect.any(Object),
    );
  });

  test('message_attachment files query /query even when Azure Search is enabled', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    const searchTool = await createFileSearchTool({
      userId: 'u1',
      files: [{ file_id: 'chat-1', filename: 'b.pdf', context: 'message_attachment' }],
    });

    await searchTool.invoke({ query: 'hello' });

    expect(axios.post).toHaveBeenCalledWith(
      'http://rag.test/query',
      expect.objectContaining({ file_id: 'chat-1' }),
      expect.any(Object),
    );
  });

  test('agent-context files query /query when Azure Search is disabled', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'false';
    const searchTool = await createFileSearchTool({
      userId: 'u1',
      files: [{ file_id: 'agent-1', filename: 'a.pdf', context: 'agents' }],
    });

    await searchTool.invoke({ query: 'hello' });

    expect(axios.post).toHaveBeenCalledWith(
      'http://rag.test/query',
      expect.objectContaining({ file_id: 'agent-1' }),
      expect.any(Object),
    );
  });
});
// End [knauf]

// [knauf] KK20-195 WP3c — seam test: primeFiles drops files whose physical
// asset is not queryable (no active generation, or delete-tombstoned) as
// defense in depth behind the request-layer 409; legacy files without an
// asset row pass through, and a status-read failure keeps upstream behavior.
describe('primeFiles readiness filter (KK20-195 WP3c)', () => {
  const { getFiles, getAssetsByAssetIds } = require('~/models');

  const rows = [
    { file_id: 'ready-1', filename: 'ready.pdf', knauf_asset_id: 'ready-1' },
    { file_id: 'pending-1', filename: 'pending.pdf', knauf_asset_id: 'pending-1' },
    { file_id: 'legacy-1', filename: 'legacy.pdf' }, // pre-FileAsset row
  ];
  const toolResources = {
    file_search: { file_ids: rows.map((r) => r.file_id) },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getFiles.mockResolvedValue(rows);
  });

  test('drops non-ready assets, keeps ready assets and legacy rows', async () => {
    getAssetsByAssetIds.mockResolvedValue([
      { asset_id: 'ready-1', active_generation: 1, delete_requested_at: null },
      { asset_id: 'pending-1', active_generation: null, delete_requested_at: null },
    ]);

    const { files } = await primeFiles({ tool_resources: toolResources });

    expect(getAssetsByAssetIds).toHaveBeenCalledWith(['ready-1', 'pending-1']);
    expect(files.map((f) => f.file_id).sort()).toEqual(['legacy-1', 'ready-1']);
  });

  test('drops delete-tombstoned assets even with an active generation', async () => {
    getAssetsByAssetIds.mockResolvedValue([
      { asset_id: 'ready-1', active_generation: 1, delete_requested_at: new Date() },
      { asset_id: 'pending-1', active_generation: 2, delete_requested_at: null },
    ]);

    const { files } = await primeFiles({ tool_resources: toolResources });

    expect(files.map((f) => f.file_id).sort()).toEqual(['legacy-1', 'pending-1']);
  });

  // KK20-195 review R5 — hydration fails CLOSED for asset-backed files.
  test('a status-read failure drops ALL asset-backed files, keeps legacy rows', async () => {
    getAssetsByAssetIds.mockRejectedValue(new Error('mongo down'));

    const { files } = await primeFiles({ tool_resources: toolResources });

    expect(files.map((f) => f.file_id)).toEqual(['legacy-1']);
  });

  test('a file whose asset is MISSING from the lookup is dropped (dangling pointer)', async () => {
    getAssetsByAssetIds.mockResolvedValue([
      { asset_id: 'ready-1', active_generation: 1, delete_requested_at: null },
      // pending-1 absent — deleted or corrupt pointer
    ]);

    const { files } = await primeFiles({ tool_resources: toolResources });

    expect(files.map((f) => f.file_id).sort()).toEqual(['legacy-1', 'ready-1']);
  });
});
// End [knauf]
