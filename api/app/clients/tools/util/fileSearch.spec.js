// [knauf] NO-TICKET — dual-backend file_search routing, canonicalization, fusion,
// deduplication, and per-run backend-budget regression tests.

jest.mock('axios');
jest.mock('@librechat/api', () => ({ generateShortLivedToken: jest.fn(() => 'jwt-token') }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.mock('~/server/services/Files/permissions', () => ({ filterFilesByAgentAccess: jest.fn() }));
jest.mock('~/models', () => ({ getFiles: jest.fn(), getAssetsByAssetIds: jest.fn() }));

const axios = require('axios');
const { createFileSearchTool, primeFiles } = require('./fileSearch');

describe('dual-backend file search', () => {
  const originalUrl = process.env.RAG_API_URL;
  const originalSearch = process.env.AZURE_SEARCH_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAG_API_URL = 'http://rag.test';
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.post.mockResolvedValue({ data: [] });
  });

  afterAll(() => {
    if (originalUrl === undefined) {
      delete process.env.RAG_API_URL;
    } else {
      process.env.RAG_API_URL = originalUrl;
    }
    if (originalSearch === undefined) {
      delete process.env.AZURE_SEARCH_ENABLED;
    } else {
      process.env.AZURE_SEARCH_ENABLED = originalSearch;
    }
  });

  test('canonicalizes physical assets and batches once per eligible backend', async () => {
    const searchTool = await createFileSearchTool({
      userId: 'u1',
      entity_id: 'agent-1',
      files: [
        {
          file_id: 'reuse-1',
          filename: 'chat.pdf',
          knauf_asset_id: 'asset-1',
          knauf_active_generation: 4,
          knauf_vector_backend: 'pgvector',
        },
        {
          file_id: 'reuse-2',
          filename: 'chat-copy.pdf',
          knauf_asset_id: 'asset-1',
          knauf_active_generation: 4,
          knauf_vector_backend: 'pgvector',
        },
        {
          file_id: 'agent-1',
          filename: 'knowledge.pdf',
          context: 'agents',
          fromAgent: true,
          knauf_active_generation: 2,
          knauf_vector_backend: 'azure_search',
        },
        { file_id: 'agent-like', filename: 'upload.pdf', context: 'agents' },
      ],
    });

    await searchTool.invoke({ query: 'hello' });

    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(axios.post).toHaveBeenCalledWith(
      'http://rag.test/query_multiple',
      {
        query: 'hello',
        file_ids: ['agent-like', 'asset-1'],
        generations: { 'agent-like': 0, 'asset-1': 4 },
        k: 10,
        entity_id: 'agent-1',
      },
      expect.any(Object),
    );
    expect(axios.post).toHaveBeenCalledWith(
      'http://rag.test/agent/query-multiple',
      {
        query: 'hello',
        file_ids: ['agent-1'],
        generations: { 'agent-1': 2 },
        k: 10,
        entity_id: 'agent-1',
      },
      expect.any(Object),
    );
  });

  test('maps physical results to authorized logical citations and deduplicates chunks', async () => {
    axios.post.mockResolvedValue({
      data: [
        [
          {
            page_content: 'Shared content',
            metadata: { file_id: 'asset-1', page: 2 },
          },
          0.2,
        ],
        [
          {
            page_content: 'Shared content',
            metadata: { file_id: 'asset-1', page: 2 },
          },
          0.1,
        ],
        [
          {
            page_content: 'Must not leak',
            metadata: { file_id: 'not-authorized', page: 1 },
          },
          0.01,
        ],
      ],
    });
    const searchTool = await createFileSearchTool({
      userId: 'u1',
      files: [
        { file_id: 'logical-2', filename: 'copy.pdf', knauf_asset_id: 'asset-1' },
        { file_id: 'logical-1', filename: 'shared.pdf', knauf_asset_id: 'asset-1' },
      ],
    });

    const [, artifact] = await searchTool.func({ query: 'shared' });

    expect(artifact.file_search.sources).toEqual([
      expect.objectContaining({
        fileId: 'logical-1',
        fileName: 'shared.pdf',
        content: 'Shared content',
      }),
    ]);
  });

  test('preserves each backend order and fuses by rank without comparing raw scores', async () => {
    axios.post.mockImplementation((url) => {
      if (url.endsWith('/query_multiple')) {
        return Promise.resolve({
          data: [
            [{ page_content: 'pg first', metadata: { file_id: 'chat-1' } }, 999],
            [{ page_content: 'pg second', metadata: { file_id: 'chat-1' } }, -999],
          ],
        });
      }
      return Promise.resolve({
        data: [
          { page_content: 'azure first', metadata: { file_id: 'kb-1' }, score: -999 },
          { page_content: 'azure second', metadata: { file_id: 'kb-1' }, score: 999 },
        ],
      });
    });
    const searchTool = await createFileSearchTool({
      userId: 'u1',
      entity_id: 'agent-1',
      files: [
        { file_id: 'chat-1', filename: 'chat.pdf' },
        { file_id: 'kb-1', filename: 'kb.pdf', context: 'agents', fromAgent: true },
      ],
    });

    const [, artifact] = await searchTool.func({ query: 'rank' });

    expect(artifact.file_search.sources.map((source) => source.content)).toEqual([
      'azure first',
      'pg first',
      'azure second',
      'pg second',
    ]);
    expect(artifact.file_search.sources.every((source) => source.relevance == null)).toBe(true);
    expect(artifact.file_search.sources.map((source) => source.metadata)).toEqual([
      expect.objectContaining({
        backend: 'azure',
        backendRank: 1,
        rankingStrategy: 'cross_backend_rrf',
      }),
      expect.objectContaining({
        backend: 'pgvector',
        backendRank: 1,
        rankingStrategy: 'cross_backend_rrf',
      }),
      expect.objectContaining({
        backend: 'azure',
        backendRank: 2,
        rankingStrategy: 'cross_backend_rrf',
      }),
      expect.objectContaining({
        backend: 'pgvector',
        backendRank: 2,
        rankingStrategy: 'cross_backend_rrf',
      }),
    ]);
  });

  test('caches normalized exact queries and returns typed exhaustion for a new query', async () => {
    let resolveSearch;
    axios.post.mockReturnValue(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );
    const searchTool = await createFileSearchTool({
      userId: 'u1',
      files: [{ file_id: 'chat-1', filename: 'chat.pdf' }],
      maxDistinctQueries: 1,
    });

    const first = searchTool.func({ query: '  Same   Query ' });
    const cached = searchTool.func({ query: 'same query' });
    expect(axios.post).toHaveBeenCalledTimes(1);
    resolveSearch({
      data: [[{ page_content: 'Cached evidence', metadata: { file_id: 'chat-1' } }, 0.2]],
    });
    const [firstResult, cachedResult] = await Promise.all([first, cached]);
    expect(firstResult[1].file_search.sources).toHaveLength(1);
    expect(cachedResult[1]).toBeUndefined();

    const [content, artifact] = await searchTool.func({ query: 'different query' });
    expect(JSON.parse(content)).toMatchObject({
      type: 'search_budget_exhausted',
      maxDistinctQueries: 1,
    });
    expect(artifact).toBeUndefined();
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('numbers distinct searches by request turn while cached repeats reuse their content', async () => {
    axios.post.mockImplementation((_url, body) =>
      Promise.resolve({
        data: [
          [
            {
              page_content: `${body.query} evidence`,
              metadata: { file_id: 'chat-1', page: 1 },
            },
            0.2,
          ],
        ],
      }),
    );
    const searchTool = await createFileSearchTool({
      userId: 'u1',
      files: [{ file_id: 'chat-1', filename: 'chat.pdf' }],
      fileCitations: true,
    });

    const first = await searchTool.func({ query: 'first' });
    const second = await searchTool.func({ query: 'second' });
    const cached = await searchTool.func({ query: ' FIRST ' });

    expect(first[0]).toContain('\\ue202turn0file0');
    expect(first[1].file_search.turn).toBe(0);
    expect(second[0]).toContain('\\ue202turn1file0');
    expect(second[1].file_search.turn).toBe(1);
    expect(cached[0]).toBe(first[0]);
    expect(cached[1]).toBeUndefined();
  });

  test('keeps cache and budget state when event-driven execution reloads the tool', async () => {
    const runContext = {};
    const options = {
      userId: 'u1',
      files: [{ file_id: 'chat-1', filename: 'chat.pdf' }],
      maxDistinctQueries: 2,
      runContext,
    };

    const firstTool = await createFileSearchTool(options);
    await firstTool.func({ query: 'first query' });

    const reloadedTool = await createFileSearchTool(options);
    const cachedReload = await reloadedTool.func({ query: ' FIRST   QUERY ' });
    expect(cachedReload[1]).toBeUndefined();
    await reloadedTool.func({ query: 'second query' });

    const reloadedAgain = await createFileSearchTool(options);
    const [content, artifact] = await reloadedAgain.func({ query: 'third query' });

    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(JSON.parse(content).type).toBe('search_budget_exhausted');
    expect(artifact).toBeUndefined();

    const nextRunTool = await createFileSearchTool({ ...options, runContext: {} });
    await nextRunTool.func({ query: 'third query' });
    expect(axios.post).toHaveBeenCalledTimes(3);
  });

  test('shares citation turns across entities while keeping their query budgets separate', async () => {
    axios.post.mockResolvedValue({
      data: [[{ page_content: 'Scoped evidence', metadata: { file_id: 'chat-1' } }, 0.2]],
    });
    const runContext = {};
    const createForEntity = (entity_id) =>
      createFileSearchTool({
        userId: 'u1',
        entity_id,
        files: [{ file_id: 'chat-1', filename: 'chat.pdf' }],
        fileCitations: true,
        maxDistinctQueries: 1,
        runContext,
      });
    const firstEntityTool = await createForEntity('agent-1');
    const secondEntityTool = await createForEntity('agent-2');

    const first = await firstEntityTool.func({ query: 'same query' });
    const second = await secondEntityTool.func({ query: 'same query' });

    expect(first[1].file_search.turn).toBe(0);
    expect(second[1].file_search.turn).toBe(1);
    expect(axios.post).toHaveBeenCalledTimes(2);

    const firstExhausted = await firstEntityTool.func({ query: 'different first query' });
    const secondExhausted = await secondEntityTool.func({ query: 'different second query' });
    expect(JSON.parse(firstExhausted[0]).type).toBe('search_budget_exhausted');
    expect(JSON.parse(secondExhausted[0]).type).toBe('search_budget_exhausted');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('does not send Azure search without an agent scope', async () => {
    const searchTool = await createFileSearchTool({
      userId: 'u1',
      files: [{ file_id: 'kb-1', filename: 'kb.pdf', context: 'agents', fromAgent: true }],
    });

    const [content, artifact] = await searchTool.func({ query: 'scope' });

    expect(content).toContain('agent scope is missing');
    expect(artifact).toBeUndefined();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('labels successful results as partial when another backend is unavailable', async () => {
    axios.post.mockResolvedValue({
      data: [[{ page_content: 'Available chat evidence', metadata: { file_id: 'chat-1' } }, 0.2]],
    });
    const searchTool = await createFileSearchTool({
      userId: 'u1',
      files: [
        { file_id: 'chat-1', filename: 'chat.pdf' },
        { file_id: 'kb-1', filename: 'kb.pdf', context: 'agents', fromAgent: true },
      ],
    });

    const [content, artifact] = await searchTool.func({ query: 'partial' });

    expect(content).toContain('Warning: azure search was unavailable; these results are partial.');
    expect(content).toContain('Available chat evidence');
    expect(artifact.file_search.sources).toEqual([
      expect.objectContaining({ fileId: 'chat-1', content: 'Available chat evidence' }),
    ]);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post.mock.calls[0][0]).toBe('http://rag.test/query_multiple');
  });

  test('preserves the partial warning when the available backend has no matches', async () => {
    const searchTool = await createFileSearchTool({
      userId: 'u1',
      files: [
        { file_id: 'chat-1', filename: 'chat.pdf' },
        { file_id: 'kb-1', filename: 'kb.pdf', context: 'agents', fromAgent: true },
      ],
    });

    const [content, artifact] = await searchTool.func({ query: 'no partial matches' });

    expect(content).toContain('Warning: azure search was unavailable; these results are partial.');
    expect(content).toContain('No matching content was found in the available files.');
    expect(content).not.toContain('refine your query');
    expect(artifact).toBeUndefined();
    expect(axios.post).toHaveBeenCalledTimes(1);
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
      {
        asset_id: 'ready-1',
        active_generation: 1,
        vector_backend: 'pgvector',
        delete_requested_at: null,
      },
      { asset_id: 'pending-1', active_generation: null, delete_requested_at: null },
    ]);

    const { files } = await primeFiles({ tool_resources: toolResources });

    expect(getAssetsByAssetIds).toHaveBeenCalledWith(['ready-1', 'pending-1']);
    expect(files.map((f) => f.file_id).sort()).toEqual(['legacy-1', 'ready-1']);
    expect(files.find((f) => f.file_id === 'ready-1')).toMatchObject({
      knauf_active_generation: 1,
      knauf_vector_backend: 'pgvector',
    });
    expect(files.find((f) => f.file_id === 'legacy-1')).toMatchObject({
      knauf_active_generation: 0,
    });
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
