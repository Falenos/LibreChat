const axios = require('axios');

jest.mock('axios');
jest.mock('@librechat/api', () => ({
  generateShortLivedToken: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('~/models', () => ({
  getFiles: jest.fn().mockResolvedValue([]),
}));

jest.mock('~/server/services/Files/permissions', () => ({
  filterFilesByAgentAccess: jest.fn((options) => Promise.resolve(options.files)),
}));

const { createFileSearchTool } = require('~/app/clients/tools/util/fileSearch');
const { generateShortLivedToken } = require('@librechat/api');
const { processFileCitations } = require('~/server/services/Files/Citations');

describe('fileSearch.js - tuple return validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAG_API_URL = 'http://localhost:8000';
  });

  describe('error cases should return tuple with undefined as second value', () => {
    it('should return tuple when no files provided', async () => {
      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [],
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('No files to search. Instruct the user to add files for the search.');
      expect(result[1]).toBeUndefined();
    });

    it('should return tuple when JWT token generation fails', async () => {
      generateShortLivedToken.mockReturnValue(null);

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'file-1', filename: 'test.pdf' }],
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('There was an error authenticating the file search request.');
      expect(result[1]).toBeUndefined();
    });

    it('should return tuple when no valid results found', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockRejectedValue(new Error('API Error'));

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'file-1', filename: 'test.pdf' }],
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('No results found or errors occurred while searching the files.');
      expect(result[1]).toBeUndefined();
    });
  });

  describe('success cases should return tuple with artifact object', () => {
    it('should return tuple with formatted results and sources artifact', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      const mockApiResponse = {
        data: [
          [
            {
              page_content: 'This is test content from the document',
              metadata: { source: '/path/to/test.pdf', page: 1 },
            },
            0.2,
          ],
          [
            {
              page_content: 'Additional relevant content',
              metadata: { source: '/path/to/test.pdf', page: 2 },
            },
            0.35,
          ],
        ],
      };

      axios.post.mockResolvedValue(mockApiResponse);

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'file-123', filename: 'test.pdf' }],
        entity_id: 'agent-456',
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);

      const [formattedString, artifact] = result;

      expect(typeof formattedString).toBe('string');
      expect(formattedString).toContain('File: test.pdf');
      expect(formattedString).toContain('Relevance:');
      expect(formattedString).toContain('This is test content from the document');
      expect(formattedString).toContain('Additional relevant content');

      expect(artifact).toBeDefined();
      expect(artifact).toHaveProperty('file_search');
      expect(artifact.file_search).toHaveProperty('sources');
      expect(artifact.file_search).toHaveProperty('fileCitations', false);
      expect(artifact.file_search).toHaveProperty('turn', 0);
      expect(Array.isArray(artifact.file_search.sources)).toBe(true);
      expect(artifact.file_search.sources.length).toBe(2);

      const source = artifact.file_search.sources[0];
      expect(source).toMatchObject({
        type: 'file',
        fileId: 'file-123',
        fileName: 'test.pdf',
        content: expect.any(String),
        relevance: expect.any(Number),
        pages: [1],
        pageRelevance: { 1: expect.any(Number) },
      });
    });

    it('should include file citations in description when enabled', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      const mockApiResponse = {
        data: [
          [
            {
              page_content: 'Content with citations',
              metadata: { source: '/path/to/doc.pdf', page: 3 },
            },
            0.15,
          ],
        ],
      };

      axios.post.mockResolvedValue(mockApiResponse);

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'file-789', filename: 'doc.pdf' }],
        fileCitations: true,
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);

      const [formattedString, artifact] = result;

      expect(formattedString).toContain('Anchor:');
      expect(formattedString).toContain('\\ue202turn0file0');
      expect(artifact.file_search.fileCitations).toBe(true);
    });

    // [knauf] NO-TICKET — anchor indexes emitted to the model must match the
    // persisted citation source indexes after the callback pipeline.
    it('preserves preselected citation order and cardinality end to end', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({
        data: ['first', 'second', 'third'].map((content, index) => [
          {
            page_content: content,
            metadata: { file_id: 'file-locked', page: index + 1 },
          },
          index / 10,
        ]),
      });
      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'file-locked', filename: 'locked.pdf' }],
        fileCitations: true,
        maxCitations: 1,
        maxCitationsPerFile: 1,
        minRelevanceScore: 0.99,
      });

      const [formattedString, artifact] = await fileSearchTool.func({ query: 'locked order' });
      const attachment = await processFileCitations({
        toolArtifact: artifact,
        toolCallId: 'call-locked',
        metadata: { run_id: 'run-1', thread_id: 'thread-1' },
        user: { id: 'user1' },
        appConfig: {
          fileStrategy: 'local',
          endpoints: {
            agents: { maxCitations: 1, maxCitationsPerFile: 1, minRelevanceScore: 0.99 },
          },
        },
      });

      expect(formattedString).toContain('\\ue202turn0file0');
      expect(formattedString).not.toContain('\\ue202turn0file1');
      expect(formattedString).toContain('first');
      expect(formattedString).not.toContain('second');
      expect(formattedString).not.toContain('third');
      expect(attachment.file_search.sources.map((source) => source.content)).toEqual(['first']);
      expect(attachment.file_search.turn).toBe(0);
    });
    // End [knauf]

    it('should handle multiple files correctly', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      // [knauf] NO-TICKET — multi-file retrieval is one backend batch and keeps
      // the backend's native ordering instead of comparing raw distance values.
      const mockResponse = {
        data: [
          [
            {
              page_content: 'Content from file 1',
              metadata: { source: '/path/to/file1.pdf', file_id: 'file-1', page: 1 },
            },
            0.25,
          ],
          [
            {
              page_content: 'Content from file 2',
              metadata: { source: '/path/to/file2.pdf', file_id: 'file-2', page: 1 },
            },
            0.15,
          ],
        ],
      };

      axios.post.mockResolvedValueOnce(mockResponse);

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          { file_id: 'file-1', filename: 'file1.pdf' },
          { file_id: 'file-2', filename: 'file2.pdf' },
        ],
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);

      const [formattedString, artifact] = result;

      expect(formattedString).toContain('file1.pdf');
      expect(formattedString).toContain('file2.pdf');
      expect(artifact.file_search.sources).toHaveLength(2);
      expect(artifact.file_search.sources[0].fileId).toBe('file-1');
      expect(artifact.file_search.sources[1].fileId).toBe('file-2');
      expect(axios.post).toHaveBeenCalledTimes(1);
      // End [knauf]
    });
  });
});

describe('entity_id scoping for batch authorization', () => {
  const ORIGINAL_RAG_API_URL = process.env.RAG_API_URL;
  const ORIGINAL_AZURE_SEARCH_ENABLED = process.env.AZURE_SEARCH_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAG_API_URL = 'http://localhost:8000';
    process.env.AZURE_SEARCH_ENABLED = 'true';
    generateShortLivedToken.mockReturnValue('mock-jwt-token');
    axios.post.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    if (ORIGINAL_RAG_API_URL === undefined) {
      delete process.env.RAG_API_URL;
    } else {
      process.env.RAG_API_URL = ORIGINAL_RAG_API_URL;
    }
    if (ORIGINAL_AZURE_SEARCH_ENABLED === undefined) {
      delete process.env.AZURE_SEARCH_ENABLED;
    } else {
      process.env.AZURE_SEARCH_ENABLED = ORIGINAL_AZURE_SEARCH_ENABLED;
    }
  });

  // [knauf] NO-TICKET — both batch contracts receive agent scope; routing still
  // sends only authorized persistent agent resources to Azure.
  it('sends agent scope to both batches while preserving resource routing', async () => {
    const tool = await createFileSearchTool({
      userId: 'user1',
      entity_id: 'agent_123',
      files: [
        { file_id: 'kb-1', filename: 'kb.pdf', context: 'agents', fromAgent: true },
        { file_id: 'user-1', filename: 'attachment.txt', fromAgent: false },
      ],
    });
    await tool.func({ query: 'q' });

    expect(axios.post).toHaveBeenCalledWith(
      'http://localhost:8000/agent/query-multiple',
      expect.objectContaining({ file_ids: ['kb-1'], entity_id: 'agent_123' }),
      expect.any(Object),
    );
    expect(axios.post).toHaveBeenCalledWith(
      'http://localhost:8000/query_multiple',
      expect.objectContaining({ file_ids: ['user-1'], entity_id: 'agent_123' }),
      expect.any(Object),
    );
  });
  // End [knauf]
});
