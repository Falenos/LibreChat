jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid') }));

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('@librechat/agents', () => ({
  getCodeBaseURL: jest.fn(() => 'http://localhost:8000'),
}));

const mockSanitizeArtifactPath = jest.fn();
const mockFlattenArtifactPath = jest.fn((name) => name.replace(/\//g, '__'));

const mockAxios = jest.fn().mockResolvedValue({
  data: Buffer.from('file-content'),
});
mockAxios.post = jest.fn();

jest.mock('@librechat/api', () => {
  const http = require('http');
  const https = require('https');
  return {
    logAxiosError: jest.fn(),
    getBasePath: jest.fn(() => ''),
    sanitizeArtifactPath: mockSanitizeArtifactPath,
    flattenArtifactPath: mockFlattenArtifactPath,
    createAxiosInstance: jest.fn(() => mockAxios),
    getCodeApiAuthHeaders: jest.fn(async () => ({})),
    classifyCodeArtifact: jest.fn(() => 'other'),
    extractCodeArtifactText: jest.fn(async () => null),
    /* `processCodeOutput` calls this to derive the trust flag persisted
     * on `IMongoFile.textFormat` — Codex P1 review on PR #12934. The
     * mock returns null in lockstep with the null `text` above so
     * downstream consumers don't see a phantom format. */
    getExtractedTextFormat: jest.fn(() => null),
    getStorageMetadata: jest.fn(() => ({})),
    /* Pass-through `withTimeout`: this suite asserts traversal sanitization,
     * not deferred preview timing. */
    withTimeout: async (promise) => promise,
    /* These traversal cases all use non-office filenames — keep the
     * inline (non-finalize) path so existing assertions on a single
     * createFile call hold. */
    hasOfficeHtmlPath: jest.fn(() => false),
    /* Identity-helper stub mirroring `packages/api/src/files/code/identity.ts`.
     * `processCodeOutput` calls this for every output download URL;
     * traversal cases don't care about the query shape, just that it
     * returns something concatable. */
    buildCodeEnvDownloadQuery: jest.fn(({ kind, id, version }) => {
      const params = new URLSearchParams({ kind, id });
      if (version != null) params.set('version', String(version));
      return `?${params.toString()}`;
    }),
    codeServerHttpAgent: new http.Agent({ keepAlive: false }),
    codeServerHttpsAgent: new https.Agent({ keepAlive: false }),
  };
});

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  mergeFileConfig: jest.fn(() => ({ serverFileSizeLimit: 100 * 1024 * 1024 })),
  getEndpointFileConfig: jest.fn(() => ({
    fileSizeLimit: 100 * 1024 * 1024,
    supportedMimeTypes: ['*/*'],
  })),
  fileConfig: { checkType: jest.fn(() => true) },
}));

jest.mock('~/models', () => ({
  createFile: jest.fn().mockResolvedValue({}),
  getFiles: jest.fn().mockResolvedValue([]),
  updateFile: jest.fn(),
  claimCodeFile: jest.fn().mockResolvedValue({ file_id: 'mock-uuid', usage: 0 }),
}));

const mockSaveBuffer = jest.fn().mockResolvedValue('/uploads/user123/mock-uuid__output.csv');

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({
    saveBuffer: mockSaveBuffer,
  })),
}));

jest.mock('~/server/services/Files/permissions', () => ({
  filterFilesByAgentAccess: jest.fn().mockResolvedValue([]),
}));

jest.mock('~/server/services/Files/images/convert', () => ({
  convertImage: jest.fn(),
}));

jest.mock('~/server/utils', () => ({
  determineFileType: jest.fn().mockResolvedValue({ mime: 'text/csv' }),
}));

jest.mock('~/server/services/Files/retention', () => ({
  getRetentionExpiry: jest.fn(() => ({})),
}));

const { createFile, claimCodeFile } = require('~/models');
const { processCodeOutput } = require('~/server/services/Files/Code/process');

/**
 * [knauf] KK20-397 — the code-output policy seams in processCodeOutput. Visual-QA renders
 * and font files must never become attachments (codeOutputPolicy.js has the rules).
 */
const baseParams = {
  req: {
    user: { id: 'user123', tenantId: 'tenantA' },
    config: { fileStrategy: 'local', imageOutputType: 'webp', fileConfig: {} },
  },
  id: 'code-file-id',
  toolCallId: 'tool-1',
  conversationId: 'conv-1',
  messageId: 'msg-1',
  session_id: 'session-1',
};

describe('[knauf] processCodeOutput code-output policy (KK20-397)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSanitizeArtifactPath.mockImplementation((name) => name);
  });

  test('a visual-QA render is not downloaded, recorded or attached', async () => {
    const result = await processCodeOutput({ ...baseParams, name: '_karl_qa/sheet-1.png' });
    expect(result).toBeNull();
    expect(mockAxios).not.toHaveBeenCalled();
    expect(claimCodeFile).not.toHaveBeenCalled();
    expect(createFile).not.toHaveBeenCalled();
  });

  test('a font file is downloaded for inspection but never recorded or stored', async () => {
    mockAxios.mockResolvedValueOnce({ data: Buffer.from('not really a font') });
    const result = await processCodeOutput({ ...baseParams, name: 'KnaufScreen-Regular.ttf' });
    expect(result).toBeNull();
    expect(claimCodeFile).not.toHaveBeenCalled();
    expect(mockSaveBuffer).not.toHaveBeenCalled();
    expect(createFile).not.toHaveBeenCalled();
  });

  test('an ordinary output is still delivered', async () => {
    mockAxios.mockResolvedValueOnce({ data: Buffer.from('a,b\n1,2\n') });
    const result = await processCodeOutput({ ...baseParams, name: 'output.csv' });
    expect(result?.file).toBeDefined();
    expect(createFile).toHaveBeenCalled();
  });
});
