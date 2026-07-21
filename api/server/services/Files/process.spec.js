jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid') }));

const mockEmbedGeneration = jest.fn().mockResolvedValue({ status: 'ready' });
const mockDeleteGeneration = jest.fn().mockResolvedValue(undefined);
jest.mock('./knauf/generationRagClient', () => ({
  createGenerationRagClient: jest.fn(() => ({
    embedGeneration: mockEmbedGeneration,
    deleteGeneration: mockDeleteGeneration,
  })),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
  runAsSystem: jest.fn((fn) => fn()),
  createTempChatExpirationDate: jest.fn(() => new Date('2030-01-01T00:00:00.000Z')),
}));

jest.mock('@librechat/agents', () => ({
  Providers: {
    XAI: 'xai',
    DEEPSEEK: 'deepseek',
    MOONSHOT: 'moonshot',
    OPENROUTER: 'openrouter',
    VERTEXAI: 'vertexai',
  },
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    Providers: actual.Providers,
    RetentionMode: actual.RetentionMode ?? { ALL: 'all', TEMPORARY: 'temporary' },
    documentParserMimeTypes: actual.documentParserMimeTypes ?? [
      /^application\/pdf$/,
      /^application\/vnd\.openxmlformats-officedocument\./,
      /^application\/vnd\.ms-excel$/,
      /^application\/vnd\.oasis\.opendocument\./,
      /^application\/(?:x-)?msexcel$/,
    ],
    mergeFileConfig: jest.fn(),
  };
});

jest.mock('@librechat/api', () => {
  const actualDataProvider = jest.requireActual('librechat-data-provider');
  const RetentionMode = actualDataProvider.RetentionMode ?? { ALL: 'all', TEMPORARY: 'temporary' };
  const getRetentionExpiry = jest.fn(() => ({}));
  return {
    sanitizeFilename: jest.fn((n) => n),
    parseText: jest.fn().mockResolvedValue({ text: '', bytes: 0 }),
    processAudioFile: jest.fn(),
    getStorageMetadata: jest.fn(() => ({})),
    recordFileIndexEmbed: jest.fn(),
    recordFileIndexProviderError: jest.fn(),
    recordFileIndexEmbedRetry: jest.fn(),
    getRetentionExpiry,
    getAgentFileRetentionExpiry: jest.fn(({ req, messageAttachment, toolResource }) => {
      const interfaceConfig = req?.config?.interfaceConfig;
      if (
        !messageAttachment &&
        !!toolResource &&
        (interfaceConfig?.retentionMode !== RetentionMode.ALL ||
          interfaceConfig?.retainAgentFiles === true)
      ) {
        return {};
      }
      return getRetentionExpiry(req);
    }),
    sweepExpiredFiles: jest.fn().mockResolvedValue({ scanned: 0, deleted: 0, failed: 0 }),
    startExpiredFileSweep: jest.fn().mockReturnValue('sweep-interval'),
  };
});

jest.mock('~/server/services/Files/images', () => ({
  convertImage: jest.fn(),
  resizeAndConvert: jest.fn(),
  resizeImageBuffer: jest.fn(),
}));

jest.mock('~/server/controllers/assistants/v2', () => ({
  addResourceFileId: jest.fn(),
  deleteResourceFileId: jest.fn(),
}));

jest.mock('~/server/controllers/assistants/helpers', () => ({
  getOpenAIClient: jest.fn(),
}));

jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: jest.fn(),
}));

jest.mock('~/models', () => ({
  createFile: jest.fn().mockResolvedValue({ file_id: 'created-file-id' }),
  // [knauf] KK20-195 review F3 — the created path writes a pending File before
  // physical work (updateFile records the blob intent; deleteFiles compensates a
  // handled failure). Both resolve so the promise chains in process.js don't blow up.
  updateFile: jest.fn().mockResolvedValue({}),
  // End [knauf]
  updateFileUsage: jest.fn(),
  deleteFiles: jest.fn().mockResolvedValue({ deletedCount: 1 }),
  findFileById: jest.fn(),
  getConvo: jest.fn(),
  getExpiredFiles: jest.fn(),
  addAgentResourceFile: jest.fn().mockResolvedValue({}),
  removeAgentResourceFiles: jest.fn(),
  // [knauf] KK20-204 — within-chat idempotency check loads the agent + its file_search files.
  getAgent: jest.fn(),
  getFiles: jest.fn(),
  // End [knauf]
  removeAgentResourceFilesFromAllAgents: jest.fn(),
  // [knauf] KK20-195 WP3b — reservation-first FileAsset lifecycle on the
  // file_search path. Defaults model the common MISS: reservation created,
  // sync claim → embed → activate. Implementations survive clearAllMocks;
  // HIT/conflict cases override per-test with mockResolvedValueOnce.
  reserveAsset: jest.fn(async (params) => ({
    asset: { ...params, status: 'uploading' },
    created: true,
  })),
  markQueued: jest.fn().mockResolvedValue({}),
  claimAsset: jest.fn(async ({ asset_id }) => ({
    asset_id,
    execution_token: 'test-token',
    target_generation: 1,
    target_index_profile: 'legacy-v0',
  })),
  activateGeneration: jest.fn().mockResolvedValue({}),
  failClaim: jest.fn().mockResolvedValue({}),
  recordStaleGeneration: jest.fn().mockResolvedValue(true),
  tombstoneForDelete: jest.fn().mockResolvedValue({}),
  markDeleteFailed: jest.fn().mockResolvedValue(true),
  removeAsset: jest.fn().mockResolvedValue(undefined),
  getAssetByAssetId: jest.fn().mockResolvedValue(null),
  // WP3c admission counters (async-accept path only); default = empty backlog.
  countActiveByScope: jest.fn().mockResolvedValue(0),
  sumActiveBytesByScope: jest.fn().mockResolvedValue(0),
  // End [knauf]
}));

jest.mock('~/server/utils/getFileStrategy', () => ({
  getFileStrategy: jest.fn().mockReturnValue('local'),
}));

jest.mock('~/server/services/Config', () => ({
  checkCapability: jest.fn().mockResolvedValue(true),
}));

jest.mock('~/server/utils/queue', () => ({
  LB_QueueAsyncCall: jest.fn(),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));

// [knauf] KK20-203/204 — single VectorDB mock covering both upstream's retention
// tests and the Knauf file_search path. deleteVectorsByIds is Knauf-only; tests that
// assert a specific uploadVectors shape override it per-case with mockResolvedValueOnce.
jest.mock('~/server/services/Files/VectorDB/crud', () => ({
  uploadVectors: jest.fn().mockResolvedValue({
    bytes: 42,
    filename: 'upload.bin',
    filepath: 'vectordb',
    embedded: true,
  }),
  deleteVectors: jest.fn(),
  deleteVectorsByIds: jest.fn(),
  deleteVectorsForFiles: jest.fn().mockResolvedValue(undefined),
  parseRetryAfterMs: jest.fn(() => 0),
  // [knauf] KK20-195 WP3b — reservation routing reads the agent-search backend flag.
  isAzureSearchEnabledForAgents: jest.fn().mockReturnValue(false),
  // End [knauf]
}));

// [knauf] KK20-204/KK20-195 — the file_search path hashes the bytes before the
// FileAsset reservation; stub so tests don't touch the disk.
jest.mock('~/server/services/Files/knauf/contentDedup', () => ({
  computeContentHash: jest.fn().mockResolvedValue('deadbeefhash'),
}));
// End [knauf]

jest.mock('~/server/utils', () => ({
  determineFileType: jest.fn(),
}));

jest.mock('~/server/services/Files/Audio/STTService', () => ({
  STTService: { getInstance: jest.fn() },
}));

const {
  getRetentionExpiry,
  getAgentFileRetentionExpiry,
  sweepExpiredFiles: sweepExpiredFilesWithDeps,
  startExpiredFileSweep: startExpiredFileSweepWithDeps,
  recordFileIndexEmbed,
  recordFileIndexProviderError,
  recordFileIndexEmbedRetry,
} = require('@librechat/api');
const {
  EToolResources,
  FileSources,
  FileContext,
  RetentionMode,
  AgentCapabilities,
} = require('librechat-data-provider');
const { mergeFileConfig } = require('librechat-data-provider');
const { checkCapability } = require('~/server/services/Config');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const db = require('~/models');
const {
  processAgentFileUpload,
  filterFile,
  processDeleteRequest,
  processFileURL,
  sweepExpiredFiles,
  startExpiredFileSweep,
} = require('./process');

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLS_MIME = 'application/vnd.ms-excel';
const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';
const ODT_MIME = 'application/vnd.oasis.opendocument.text';
const ODP_MIME = 'application/vnd.oasis.opendocument.presentation';
const ODG_MIME = 'application/vnd.oasis.opendocument.graphics';

const makeReq = ({ mimetype = PDF_MIME, ocrConfig = null, interfaceConfig, body } = {}) => ({
  user: { id: 'user-123', tenantId: 'tenant-a' },
  file: {
    path: '/tmp/upload.bin',
    originalname: 'upload.bin',
    filename: 'upload-uuid.bin',
    mimetype,
  },
  body: { model: 'gpt-4o', ...body },
  config: {
    fileConfig: {},
    fileStrategy: 'local',
    ocr: ocrConfig,
    ...(interfaceConfig ? { interfaceConfig } : {}),
  },
});

const makeMetadata = () => ({
  agent_id: 'agent-abc',
  tool_resource: EToolResources.context,
  file_id: 'file-uuid-123',
});

const mockRes = {
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnValue({}),
};

const makeFileConfig = ({ ocrSupportedMimeTypes = [] } = {}) => ({
  checkType: (mime, types) => (types ?? []).includes(mime),
  ocr: { supportedMimeTypes: ocrSupportedMimeTypes },
  stt: { supportedMimeTypes: [] },
  text: { supportedMimeTypes: [] },
});

const setupStoredFileUpload = (result = {}) => {
  const handleFileUpload = jest.fn().mockResolvedValue({
    bytes: 42,
    filename: 'upload.bin',
    filepath: '/uploads/upload.bin',
    ...result,
  });
  getStrategyFunctions.mockReturnValue({ handleFileUpload });
  return handleFileUpload;
};

describe('processAgentFileUpload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRes.status.mockReturnThis();
    mockRes.json.mockReturnValue({});
    checkCapability.mockResolvedValue(true);
    getStrategyFunctions.mockReturnValue({
      handleFileUpload: jest
        .fn()
        .mockResolvedValue({ text: 'extracted text', bytes: 42, filepath: 'doc://result' }),
    });
    mergeFileConfig.mockReturnValue(makeFileConfig());
  });

  describe('OCR strategy selection', () => {
    test.each([
      ['PDF', PDF_MIME],
      ['DOCX', DOCX_MIME],
      ['XLSX', XLSX_MIME],
      ['XLS', XLS_MIME],
      ['ODS', ODS_MIME],
      ['Excel variant (msexcel)', 'application/msexcel'],
      ['Excel variant (x-msexcel)', 'application/x-msexcel'],
    ])('uses document_parser automatically for %s when no OCR is configured', async (_, mime) => {
      mergeFileConfig.mockReturnValue(makeFileConfig());
      const req = makeReq({ mimetype: mime, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
    });

    test('does not check OCR capability when using automatic document_parser fallback', async () => {
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).not.toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
    });

    test('uses the configured OCR strategy when OCR is set up for the file type', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.mistral_ocr);
    });

    test('uses document_parser as default when OCR is configured but no strategy is specified', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { supportedMimeTypes: [PDF_MIME] },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
    });

    test('throws when configured OCR capability is not enabled for the agent', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      checkCapability.mockResolvedValue(false);
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow('OCR capability is not enabled for Agents');
    });

    test('uses document_parser (no capability check) when OCR capability returns false but no OCR config', async () => {
      checkCapability.mockResolvedValue(false);
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).not.toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
    });

    test('uses document_parser when OCR is configured but the file type is not in OCR supported types', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      const req = makeReq({
        mimetype: DOCX_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).not.toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
      expect(getStrategyFunctions).not.toHaveBeenCalledWith(FileSources.mistral_ocr);
    });

    test('does not invoke any OCR strategy for unsupported MIME types without OCR config', async () => {
      const req = makeReq({ mimetype: 'text/plain', ocrConfig: null });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow('File type text/plain is not supported for text parsing.');

      expect(getStrategyFunctions).not.toHaveBeenCalled();
    });

    test.each([
      ['ODT', ODT_MIME],
      ['ODP', ODP_MIME],
      ['ODG', ODG_MIME],
    ])('routes %s through configured OCR when OCR supports the type', async (_, mime) => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [mime] }));
      const req = makeReq({
        mimetype: mime,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.mistral_ocr);
    });

    test('throws instead of falling back to parseText when document_parser fails for a document MIME type', async () => {
      getStrategyFunctions.mockReturnValue({
        handleFileUpload: jest.fn().mockRejectedValue(new Error('No text found in document')),
      });
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });
      const { parseText } = require('@librechat/api');

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow(/image-based and requires an OCR service/);

      expect(parseText).not.toHaveBeenCalled();
    });

    test('falls back to document_parser when configured OCR fails for a document MIME type', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      const failingUpload = jest.fn().mockRejectedValue(new Error('OCR API returned 500'));
      const fallbackUpload = jest
        .fn()
        .mockResolvedValue({ text: 'parsed text', bytes: 11, filepath: 'doc://result' });
      getStrategyFunctions
        .mockReturnValueOnce({ handleFileUpload: failingUpload })
        .mockReturnValueOnce({ handleFileUpload: fallbackUpload });
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).resolves.not.toThrow();

      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.mistral_ocr);
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
    });

    test('throws when both configured OCR and document_parser fallback fail', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      getStrategyFunctions.mockReturnValue({
        handleFileUpload: jest.fn().mockRejectedValue(new Error('failure')),
      });
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });
      const { parseText } = require('@librechat/api');

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow(/image-based and requires an OCR service/);

      expect(parseText).not.toHaveBeenCalled();
    });
  });

  describe('text size guard', () => {
    test('throws before writing to MongoDB when extracted text exceeds 15MB', async () => {
      const oversizedText = 'x'.repeat(15 * 1024 * 1024 + 1);
      getStrategyFunctions.mockReturnValue({
        handleFileUpload: jest.fn().mockResolvedValue({
          text: oversizedText,
          bytes: Buffer.byteLength(oversizedText, 'utf8'),
          filepath: 'doc://result',
        }),
      });
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });
      const { createFile } = require('~/models');

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow(/exceeds the 15MB storage limit/);

      expect(createFile).not.toHaveBeenCalled();
    });

    test('succeeds when extracted text is within the 15MB limit', async () => {
      const okText = 'x'.repeat(1024);
      getStrategyFunctions.mockReturnValue({
        handleFileUpload: jest.fn().mockResolvedValue({
          text: okText,
          bytes: Buffer.byteLength(okText, 'utf8'),
          filepath: 'doc://result',
        }),
      });
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).resolves.not.toThrow();
    });
  });

  describe('retention for agent resource uploads', () => {
    test('skips retention metadata for persistent agent context files outside all-data retention when retainAgentFiles is disabled', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: null,
        interfaceConfig: { retentionMode: RetentionMode.TEMPORARY, retainAgentFiles: false },
        body: { conversationId: 'temporary-convo', isTemporary: true },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getAgentFileRetentionExpiry).toHaveBeenCalledWith(
        {
          req,
          messageAttachment: false,
          toolResource: EToolResources.context,
        },
        expect.any(Object),
      );
      expect(getRetentionExpiry).not.toHaveBeenCalled();
      expect(db.createFile).toHaveBeenCalledWith(expect.not.objectContaining({ expiredAt }), true);
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.context,
        }),
      );
    });

    test('skips retention metadata for persistent agent context files outside all-data retention when retainAgentFiles is enabled', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: null,
        interfaceConfig: { retentionMode: RetentionMode.TEMPORARY, retainAgentFiles: true },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getRetentionExpiry).not.toHaveBeenCalled();
      expect(db.createFile).toHaveBeenCalledWith(expect.not.objectContaining({ expiredAt }), true);
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.context,
        }),
      );
    });

    test('applies all-data retention metadata to persistent agent context files when retainAgentFiles is disabled', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      getRetentionExpiry.mockResolvedValueOnce({ expiredAt });
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: null,
        interfaceConfig: { retentionMode: RetentionMode.ALL, retainAgentFiles: false },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getRetentionExpiry).toHaveBeenCalledTimes(1);
      expect(getRetentionExpiry.mock.calls[0][0]).toBe(req);
      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          expiredAt,
          context: FileContext.agents,
        }),
        true,
      );
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.context,
        }),
      );
    });

    test('skips all-data retention metadata for persistent agent context files when retainAgentFiles is enabled', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: null,
        interfaceConfig: { retentionMode: RetentionMode.ALL, retainAgentFiles: true },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getAgentFileRetentionExpiry).toHaveBeenCalledWith(
        {
          req,
          messageAttachment: false,
          toolResource: EToolResources.context,
        },
        expect.any(Object),
      );
      expect(getRetentionExpiry).not.toHaveBeenCalled();
      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          context: FileContext.agents,
        }),
        true,
      );
      expect(db.createFile).toHaveBeenCalledWith(expect.not.objectContaining({ expiredAt }), true);
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.context,
        }),
      );
    });

    test('applies retention metadata to context files uploaded as message attachments', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      getRetentionExpiry.mockResolvedValueOnce({ expiredAt });
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: { ...makeMetadata(), message_file: true },
      });

      expect(getRetentionExpiry).toHaveBeenCalledTimes(1);
      expect(getRetentionExpiry.mock.calls[0][0]).toBe(req);
      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          expiredAt,
          context: FileContext.message_attachment,
        }),
        true,
      );
      expect(db.addAgentResourceFile).not.toHaveBeenCalled();
    });

    test('skips retention metadata for persistent agent file-search files outside all-data retention', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      setupStoredFileUpload();
      const req = makeReq({ mimetype: 'text/plain', ocrConfig: null });

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: { ...makeMetadata(), tool_resource: EToolResources.file_search },
      });

      expect(mockEmbedGeneration).toHaveBeenCalled();
      expect(getRetentionExpiry).not.toHaveBeenCalled();
      expect(db.createFile).toHaveBeenCalledWith(expect.not.objectContaining({ expiredAt }), true, {
        userId: 'user-123',
        tenantId: 'tenant-a',
      });
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.file_search,
        }),
      );
    });

    test('applies all-data retention metadata to persistent agent file-search files', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      getRetentionExpiry.mockResolvedValueOnce({ expiredAt });
      setupStoredFileUpload();
      const req = makeReq({
        mimetype: 'text/plain',
        ocrConfig: null,
        interfaceConfig: { retentionMode: RetentionMode.ALL },
      });

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: { ...makeMetadata(), tool_resource: EToolResources.file_search },
      });

      expect(mockEmbedGeneration).toHaveBeenCalled();
      expect(getRetentionExpiry).toHaveBeenCalledTimes(1);
      expect(getRetentionExpiry.mock.calls[0][0]).toBe(req);
      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          expiredAt,
          context: FileContext.agents,
        }),
        true,
        { userId: 'user-123', tenantId: 'tenant-a' },
      );
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.file_search,
        }),
      );
    });
  });

  /* Phase C / option α regression: the upload must persist its sandbox
   * pointer under `metadata.codeEnvRef` (the post-cutover schema). The
   * legacy `metadata.fileIdentifier` key is silently stripped by mongoose
   * strict mode and downstream readers (`primeFiles`, `getCodeFilesByIds`,
   * `categorizeFileForToolResources`, controller filtering) only check
   * `codeEnvRef`. Storing under the legacy key would orphan the file —
   * priming would skip it on subsequent code-execution turns and the
   * sandbox copy would never re-mount. */
  describe('execute_code uploads persist codeEnvRef metadata', () => {
    const fs = require('fs');
    const { Readable } = require('stream');
    let createReadStreamSpy;

    beforeEach(() => {
      /* `processAgentFileUpload` opens the multer-staged temp file via
       * `fs.createReadStream`. The test fixture path doesn't exist, so
       * stub it to a tiny in-memory stream. */
      createReadStreamSpy = jest
        .spyOn(fs, 'createReadStream')
        .mockImplementation(() => Readable.from(Buffer.from('')));
    });

    afterEach(() => {
      createReadStreamSpy.mockRestore();
    });

    const setupCodeEnvUpload = (uploaded) => {
      /* `processAgentFileUpload` calls `getStrategyFunctions` twice:
       * once with `execute_code` for the codeapi upload, then again with
       * the on-disk strategy (`local`) for the standard storage step that
       * runs in the same flow. Both must return a working
       * `handleFileUpload`. */
      const codeEnvUpload = jest.fn().mockResolvedValue(uploaded);
      const localUpload = jest.fn().mockResolvedValue({
        bytes: 0,
        filename: 'upload.bin',
        filepath: '/uploads/upload.bin',
      });
      getStrategyFunctions.mockImplementation((src) =>
        src === FileSources.execute_code
          ? { handleFileUpload: codeEnvUpload }
          : { handleFileUpload: localUpload, saveBuffer: jest.fn() },
      );
      return codeEnvUpload;
    };

    it('persists kind:user codeEnvRef for chat attachments (messageAttachment=true)', async () => {
      setupCodeEnvUpload({ storage_session_id: 'sess-1', file_id: 'fid-1' });
      const req = makeReq();
      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
          file_id: 'file-uuid',
          message_file: true,
        },
      });

      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            codeEnvRef: {
              kind: 'user',
              id: 'user-123',
              storage_session_id: 'sess-1',
              file_id: 'fid-1',
            },
          },
        }),
        true,
        { userId: 'user-123', tenantId: 'tenant-a' },
      );
    });

    it('persists kind:agent codeEnvRef for agent setup files (messageAttachment=false)', async () => {
      setupCodeEnvUpload({ storage_session_id: 'sess-2', file_id: 'fid-2' });
      const req = makeReq();
      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
          file_id: 'file-uuid',
        },
      });

      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            codeEnvRef: {
              kind: 'agent',
              id: 'agent-abc',
              storage_session_id: 'sess-2',
              file_id: 'fid-2',
            },
          },
        }),
        true,
        { userId: 'user-123', tenantId: 'tenant-a' },
      );
    });

    it('skips retention metadata for persistent agent execute_code files outside all-data retention', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      setupCodeEnvUpload({ storage_session_id: 'sess-4', file_id: 'fid-4' });
      const req = makeReq();

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
          file_id: 'file-uuid',
        },
      });

      expect(getRetentionExpiry).not.toHaveBeenCalled();
      expect(db.createFile).toHaveBeenCalledWith(expect.not.objectContaining({ expiredAt }), true, {
        userId: 'user-123',
        tenantId: 'tenant-a',
      });
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
        }),
      );
    });

    it('applies all-data retention metadata to persistent agent execute_code files', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      getRetentionExpiry.mockResolvedValueOnce({ expiredAt });
      setupCodeEnvUpload({ storage_session_id: 'sess-5', file_id: 'fid-5' });
      const req = makeReq({ interfaceConfig: { retentionMode: RetentionMode.ALL } });

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
          file_id: 'file-uuid',
        },
      });

      expect(getRetentionExpiry).toHaveBeenCalledTimes(1);
      expect(getRetentionExpiry.mock.calls[0][0]).toBe(req);
      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          expiredAt,
          context: FileContext.agents,
          metadata: {
            codeEnvRef: {
              kind: 'agent',
              id: 'agent-abc',
              storage_session_id: 'sess-5',
              file_id: 'fid-5',
            },
          },
        }),
        true,
        { userId: 'user-123', tenantId: 'tenant-a' },
      );
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
        }),
      );
    });

    it('does not persist legacy fileIdentifier key (mongoose strict drops it)', async () => {
      setupCodeEnvUpload({ storage_session_id: 'sess-3', file_id: 'fid-3' });
      const req = makeReq();
      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
          file_id: 'file-uuid',
          message_file: true,
        },
      });

      const persisted = db.createFile.mock.calls[0][0];
      expect(persisted.metadata).not.toHaveProperty('fileIdentifier');
    });
  });
});

describe('processFileURL', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws and skips DB persistence when saveURL returns null', async () => {
    const saveURL = jest.fn().mockResolvedValue(null);
    const getFileURL = jest.fn();
    getStrategyFunctions.mockReturnValue({ saveURL, getFileURL });

    await expect(
      processFileURL({
        fileStrategy: FileSources.local,
        userId: 'user-123',
        URL: 'https://example.com/image.png',
        fileName: 'image.png',
        basePath: 'images',
        context: FileContext.image_generation,
        tenantId: 'tenant-a',
      }),
    ).rejects.toThrow('Strategy "local" did not save "image.png"');

    expect(getFileURL).not.toHaveBeenCalled();
    expect(db.createFile).not.toHaveBeenCalled();
  });

  it('persists tenantId and strategy-returned filepath metadata', async () => {
    const saveURL = jest.fn().mockResolvedValue({
      filepath: 'https://cdn.example.com/t/tenant-a/images/user-123/image.png',
      bytes: 512,
      type: 'image/png',
      dimensions: { width: 32, height: 64 },
    });
    const getFileURL = jest.fn();
    getStrategyFunctions.mockReturnValue({ saveURL, getFileURL });

    await processFileURL({
      fileStrategy: FileSources.cloudfront,
      userId: 'user-123',
      URL: 'https://example.com/image.png',
      fileName: 'image.png',
      basePath: 'images',
      context: FileContext.image_generation,
      tenantId: 'tenant-a',
    });

    expect(getFileURL).not.toHaveBeenCalled();
    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'user-123',
        filepath: 'https://cdn.example.com/t/tenant-a/images/user-123/image.png',
        bytes: 512,
        filename: 'image.png',
        source: FileSources.cloudfront,
        type: 'image/png',
        context: FileContext.image_generation,
        tenantId: 'tenant-a',
        width: 32,
        height: 64,
      }),
      true,
    );
  });

  it('applies retention metadata for generated images when retention mode is all', async () => {
    getRetentionExpiry.mockResolvedValueOnce({
      expiredAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const saveURL = jest.fn().mockResolvedValue({
      filepath: 'https://cdn.example.com/t/tenant-a/images/user-123/image.png',
      bytes: 512,
      type: 'image/png',
    });
    const getFileURL = jest.fn();
    getStrategyFunctions.mockReturnValue({ saveURL, getFileURL });

    await processFileURL({
      fileStrategy: FileSources.cloudfront,
      userId: 'user-123',
      URL: 'https://example.com/image.png',
      fileName: 'image.png',
      basePath: 'images',
      context: FileContext.image_generation,
      tenantId: 'tenant-a',
      req: {
        user: { id: 'user-123', tenantId: 'tenant-a' },
        body: {},
        config: { interfaceConfig: { retentionMode: 'all', retainAgentFiles: true } },
      },
    });

    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        expiredAt: new Date('2030-01-01T00:00:00.000Z'),
      }),
      true,
    );
  });

  it('applies retention metadata for retained non-temporary conversations', async () => {
    const saveURL = jest.fn().mockResolvedValue({
      filepath: 'https://cdn.example.com/t/tenant-a/images/user-123/image.png',
      bytes: 512,
      type: 'image/png',
    });
    const getFileURL = jest.fn();
    getStrategyFunctions.mockReturnValue({ saveURL, getFileURL });
    getRetentionExpiry.mockResolvedValueOnce({
      expiredAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    await processFileURL({
      fileStrategy: FileSources.cloudfront,
      userId: 'user-123',
      URL: 'https://example.com/image.png',
      fileName: 'image.png',
      basePath: 'images',
      context: FileContext.image_generation,
      tenantId: 'tenant-a',
      req: {
        user: { id: 'user-123', tenantId: 'tenant-a' },
        body: { conversationId: 'convo-123' },
        config: { interfaceConfig: { retentionMode: RetentionMode.TEMPORARY } },
      },
    });

    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        expiredAt: new Date('2030-01-01T00:00:00.000Z'),
      }),
      true,
    );
  });

  it('keeps expired retained conversation files on the parent expiration', async () => {
    const parentExpiredAt = new Date('2020-01-01T00:00:00.000Z');
    const saveURL = jest.fn().mockResolvedValue({
      filepath: 'https://cdn.example.com/t/tenant-a/images/user-123/image.png',
      bytes: 512,
      type: 'image/png',
    });
    const getFileURL = jest.fn();
    getStrategyFunctions.mockReturnValue({ saveURL, getFileURL });
    getRetentionExpiry.mockResolvedValueOnce({ expiredAt: parentExpiredAt });

    await processFileURL({
      fileStrategy: FileSources.cloudfront,
      userId: 'user-123',
      URL: 'https://example.com/image.png',
      fileName: 'image.png',
      basePath: 'images',
      context: FileContext.image_generation,
      tenantId: 'tenant-a',
      req: {
        user: { id: 'user-123', tenantId: 'tenant-a' },
        body: { conversationId: 'convo-123' },
        config: { interfaceConfig: { retentionMode: RetentionMode.TEMPORARY } },
      },
    });

    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        expiredAt: parentExpiredAt,
      }),
      true,
    );
  });

  it('falls back to getFileURL with user and tenant context when metadata lacks filepath', async () => {
    const saveURL = jest.fn().mockResolvedValue({
      bytes: 256,
      type: 'image/png',
    });
    const getFileURL = jest
      .fn()
      .mockResolvedValue('https://cdn.example.com/t/tenant-a/images/user-123/image.png');
    getStrategyFunctions.mockReturnValue({ saveURL, getFileURL });

    await processFileURL({
      fileStrategy: FileSources.cloudfront,
      userId: 'user-123',
      URL: 'https://example.com/image.png',
      fileName: 'image.png',
      basePath: 'images',
      context: FileContext.image_generation,
      tenantId: 'tenant-a',
    });

    expect(getFileURL).toHaveBeenCalledWith({
      userId: 'user-123',
      fileName: 'image.png',
      basePath: 'images',
      tenantId: 'tenant-a',
    });
    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filepath: 'https://cdn.example.com/t/tenant-a/images/user-123/image.png',
        tenantId: 'tenant-a',
      }),
      true,
    );
  });

  it('preserves the user path segment for local fallback URLs', async () => {
    const saveURL = jest.fn().mockResolvedValue({
      bytes: 256,
      type: 'image/png',
    });
    const getFileURL = jest.fn().mockResolvedValue('/images/user-123/image.png');
    getStrategyFunctions.mockReturnValue({ saveURL, getFileURL });

    await processFileURL({
      fileStrategy: FileSources.local,
      userId: 'user-123',
      URL: 'https://example.com/image.png',
      fileName: 'image.png',
      basePath: 'images',
      context: FileContext.image_generation,
      tenantId: 'tenant-a',
    });

    expect(getFileURL).toHaveBeenCalledWith({
      userId: 'user-123',
      fileName: 'user-123/image.png',
      basePath: 'images',
      tenantId: 'tenant-a',
    });
    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filepath: '/images/user-123/image.png',
        tenantId: 'tenant-a',
      }),
      true,
    );
  });
});

describe('processDeleteRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('removes metadata when backing storage is already missing', async () => {
    const missingError = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const deleteFile = jest.fn().mockRejectedValue(missingError);
    getStrategyFunctions.mockReturnValue({ deleteFile });
    db.deleteFiles.mockResolvedValue({ deletedCount: 1 });

    const result = await processDeleteRequest({
      req: {
        body: {},
        config: {},
        user: { id: 'user-123', tenantId: 'tenant-a' },
      },
      files: [
        {
          file_id: 'expired-file',
          filepath: '/images/user-123/expired.png',
          source: FileSources.local,
        },
      ],
    });

    expect(db.deleteFiles).toHaveBeenCalledWith(['expired-file']);
    expect(result).toEqual({ deletedFileIds: ['expired-file'], failedFileIds: [] });
  });

  // [knauf] KK20-195 WP3d — deleted rows settle their FileAsset ledger entry.
  it('tombstones and removes the asset when the deleted row was its last reference (WP3d)', async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockReturnValue({ deleteFile });
    db.deleteFiles.mockResolvedValue({ deletedCount: 1 });
    db.getFiles.mockResolvedValue([]); // recount after row delete: no survivors
    db.tombstoneForDelete.mockResolvedValueOnce({
      asset_id: 'kb-file',
      status: 'deleting',
      scope_type: 'user',
      scope_id: 'user-123',
      vector_backend: 'pgvector',
      active_generation: 3,
      target_generation: 4,
      stale_generations: [2],
      blob: { source: FileSources.local, path: '/blob/kb' },
    });

    await processDeleteRequest({
      req: { body: {}, config: {}, user: { id: 'user-123', tenantId: 'tenant-a' } },
      files: [
        {
          file_id: 'kb-file',
          knauf_asset_id: 'kb-file',
          filepath: '/blob/kb',
          source: FileSources.local,
        },
      ],
    });

    expect(db.getFiles).toHaveBeenCalledWith(
      { knauf_asset_id: 'kb-file', file_id: { $nin: ['kb-file'] } },
      null,
      { file_id: 1 },
    );
    expect(db.tombstoneForDelete).toHaveBeenCalledWith({ asset_id: 'kb-file' });
    expect(mockDeleteGeneration.mock.calls.map(([arg]) => arg.generation)).toEqual([3, 4, 2]);
    expect(deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'user-123' }) }),
      expect.objectContaining({ file_id: 'kb-file', filepath: '/blob/kb', embedded: false }),
    );
    expect(db.removeAsset).toHaveBeenCalledWith({ asset_id: 'kb-file' });
  });

  // KK20-195 review R4 — §8.2: a last-reference asset is tombstoned BEFORE
  // its blob/vectors are destroyed, so nothing can claim/activate mid-delete.
  it('pre-tombstones a last-reference asset BEFORE physical deletion (R4)', async () => {
    const sequence = [];
    const deleteFile = jest.fn(async () => {
      sequence.push('physical');
    });
    getStrategyFunctions.mockReturnValue({ deleteFile });
    db.deleteFiles.mockResolvedValue({ deletedCount: 1 });
    db.getFiles.mockResolvedValue([]); // no references outside the delete set
    db.tombstoneForDelete.mockImplementationOnce(async () => {
      sequence.push('tombstone');
      return {
        asset_id: 'kb-file',
        status: 'deleting',
        scope_type: 'user',
        scope_id: 'user-123',
        vector_backend: 'pgvector',
        active_generation: 1,
        blob: { source: FileSources.local, path: '/blob/kb' },
      };
    });

    await processDeleteRequest({
      req: { body: {}, config: {}, user: { id: 'user-123', tenantId: 'tenant-a' } },
      files: [
        {
          file_id: 'kb-file',
          knauf_asset_id: 'kb-file',
          filepath: '/blob/kb',
          source: FileSources.local,
        },
      ],
    });

    expect(sequence[0]).toBe('tombstone'); // §8.2 ordering
    expect(sequence).toContain('physical');
  });

  it('leaves the asset untouched while other rows still reference it (WP3d)', async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockReturnValue({ deleteFile });
    db.deleteFiles.mockResolvedValue({ deletedCount: 1 });
    db.getFiles.mockResolvedValue([{ file_id: 'survivor' }]); // reference remains on both recounts

    await processDeleteRequest({
      req: { body: {}, config: {}, user: { id: 'user-123', tenantId: 'tenant-a' } },
      files: [
        {
          file_id: 'shared-ref',
          knauf_asset_id: 'shared-asset',
          filepath: '/blob/shared',
          source: FileSources.local,
        },
      ],
    });

    expect(db.tombstoneForDelete).not.toHaveBeenCalled();
    expect(db.getFiles).toHaveBeenCalledTimes(2); // pre-delete + retained-orphan recount
    expect(db.removeAsset).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled(); // shared physical state stays live
    expect(db.deleteFiles).toHaveBeenCalledWith(['shared-ref']); // logical reference is removed
  });

  // KK20-195 review F5 (re-review) — the pre-tombstone is the deletion FENCE. If
  // it fails, the asset may still be claimable/activatable, so physical deletion
  // MUST be skipped and the row kept (reported failed); the reconciler retries.
  it('skips physical deletion when the pre-tombstone fence fails (F5)', async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockReturnValue({ deleteFile });
    db.getFiles.mockResolvedValue([]); // no survivors → the fence would apply
    db.tombstoneForDelete.mockRejectedValue(new Error('mongo down')); // fence fails

    const result = await processDeleteRequest({
      req: {
        body: { agent_id: 'agent-1', tool_resource: EToolResources.file_search },
        config: {},
        user: { id: 'user-123', tenantId: 'tenant-a' },
      },
      files: [
        {
          file_id: 'unfenced-file',
          knauf_asset_id: 'unfenced-asset',
          filepath: '/blob/unfenced',
          source: FileSources.local,
        },
      ],
    });

    expect(deleteFile).not.toHaveBeenCalled(); // no blob/vector delete under a live asset
    expect(db.deleteFiles).not.toHaveBeenCalled(); // row kept → reference preserved
    expect(db.removeAgentResourceFiles).not.toHaveBeenCalled(); // logical reference stays attached
    expect(result).toEqual({ deletedFileIds: [], failedFileIds: ['unfenced-file'] });
  });

  it('keeps metadata and records delete_failed when a ledger generation cannot be removed', async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockReturnValue({ deleteFile });
    db.getFiles.mockResolvedValue([]);
    db.tombstoneForDelete.mockResolvedValueOnce({
      asset_id: 'generation-fail',
      status: 'deleting',
      scope_type: 'user',
      scope_id: 'user-123',
      vector_backend: 'pgvector',
      active_generation: 7,
      blob: { source: FileSources.local, path: '/blob/generation-fail' },
    });
    mockDeleteGeneration.mockRejectedValueOnce(new Error('rag unavailable'));

    const result = await processDeleteRequest({
      req: { body: {}, config: {}, user: { id: 'user-123', tenantId: 'tenant-a' } },
      files: [
        {
          file_id: 'logical-file',
          knauf_asset_id: 'generation-fail',
          filepath: '/blob/generation-fail',
          source: FileSources.local,
          embedded: false,
        },
      ],
    });

    expect(mockDeleteGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ asset_id: 'generation-fail', generation: 7 }),
    );
    expect(db.markDeleteFailed).toHaveBeenCalledWith({
      asset_id: 'generation-fail',
      error_code: 'physical_cleanup_failed',
    });
    expect(db.deleteFiles).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedFileIds: [], failedFileIds: ['logical-file'] });
  });

  it('keeps the tombstoned ledger when logical metadata deletion fails after physical cleanup', async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockReturnValue({ deleteFile });
    db.getFiles.mockResolvedValue([]);
    db.tombstoneForDelete.mockResolvedValueOnce({
      asset_id: 'metadata-fail',
      status: 'deleting',
      scope_type: 'user',
      scope_id: 'user-123',
      vector_backend: 'pgvector',
      active_generation: 2,
      blob: { source: FileSources.local, path: '/blob/metadata-fail' },
    });
    db.deleteFiles.mockRejectedValueOnce(new Error('mongo unavailable'));

    await expect(
      processDeleteRequest({
        req: { body: {}, config: {}, user: { id: 'user-123', tenantId: 'tenant-a' } },
        files: [
          {
            file_id: 'logical-file',
            knauf_asset_id: 'metadata-fail',
            filepath: '/blob/metadata-fail',
            source: FileSources.local,
          },
        ],
      }),
    ).rejects.toThrow('mongo unavailable');

    expect(mockDeleteGeneration).toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalled();
    expect(db.removeAsset).not.toHaveBeenCalled();
  });
  // End [knauf]

  it('does not treat unrelated not found messages as missing storage', async () => {
    const deleteFile = jest.fn().mockRejectedValue(new Error('Configuration not found'));
    getStrategyFunctions.mockReturnValue({ deleteFile });

    const result = await processDeleteRequest({
      req: {
        body: {},
        config: {},
        user: { id: 'user-123', tenantId: 'tenant-a' },
      },
      files: [
        {
          file_id: 'expired-file',
          filepath: '/images/user-123/expired.png',
          source: FileSources.local,
        },
      ],
    });

    expect(db.deleteFiles).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedFileIds: [], failedFileIds: ['expired-file'] });
  });

  it('throws metadata delete failures after storage deletion succeeds', async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const metadataError = new Error('mongo unavailable');
    getStrategyFunctions.mockReturnValue({ deleteFile });
    db.deleteFiles.mockRejectedValue(metadataError);

    await expect(
      processDeleteRequest({
        req: {
          body: {},
          config: {},
          user: { id: 'user-123', tenantId: 'tenant-a' },
        },
        files: [
          {
            file_id: 'expired-file',
            filepath: '/images/user-123/expired.png',
            source: FileSources.local,
          },
        ],
      }),
    ).rejects.toThrow('mongo unavailable');

    expect(db.deleteFiles).toHaveBeenCalledWith(['expired-file']);
    expect(db.removeAgentResourceFilesFromAllAgents).not.toHaveBeenCalled();
  });

  it('deletes vector storage before removing embedded file metadata', async () => {
    const primaryDelete = jest.fn().mockResolvedValue(undefined);
    const vectorDelete = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockImplementation((source) =>
      source === FileSources.vectordb
        ? { deleteFile: vectorDelete }
        : { deleteFile: primaryDelete },
    );
    db.deleteFiles.mockResolvedValue({ deletedCount: 1 });
    const req = {
      body: {},
      config: {},
      user: { id: 'user-123', tenantId: 'tenant-a' },
    };
    const file = {
      file_id: 'embedded-file',
      filepath: '/uploads/embedded.txt',
      source: FileSources.local,
      embedded: true,
    };

    const result = await processDeleteRequest({ req, files: [file] });

    expect(primaryDelete).toHaveBeenCalledWith(req, file, undefined);
    expect(vectorDelete).toHaveBeenCalledWith(req, file);
    expect(db.deleteFiles).toHaveBeenCalledWith(['embedded-file']);
    expect(result).toEqual({ deletedFileIds: ['embedded-file'], failedFileIds: [] });
  });

  it('keeps embedded file metadata when vector deletion fails', async () => {
    const primaryDelete = jest.fn().mockResolvedValue(undefined);
    const vectorDelete = jest.fn().mockRejectedValue(new Error('rag unavailable'));
    getStrategyFunctions.mockImplementation((source) =>
      source === FileSources.vectordb
        ? { deleteFile: vectorDelete }
        : { deleteFile: primaryDelete },
    );
    const req = {
      body: {},
      config: {},
      user: { id: 'user-123', tenantId: 'tenant-a' },
    };
    const file = {
      file_id: 'embedded-file',
      filepath: '/uploads/embedded.txt',
      source: FileSources.local,
      embedded: true,
    };

    const result = await processDeleteRequest({ req, files: [file] });

    expect(primaryDelete).toHaveBeenCalledWith(req, file, undefined);
    expect(vectorDelete).toHaveBeenCalledWith(req, file);
    expect(db.deleteFiles).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedFileIds: [], failedFileIds: ['embedded-file'] });
  });

  it('does not delete vector storage when primary embedded file deletion fails', async () => {
    const primaryDelete = jest.fn().mockRejectedValue(new Error('permission denied'));
    const vectorDelete = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockImplementation((source) =>
      source === FileSources.vectordb
        ? { deleteFile: vectorDelete }
        : { deleteFile: primaryDelete },
    );
    const req = {
      body: {},
      config: {},
      user: { id: 'user-123', tenantId: 'tenant-a' },
    };
    const file = {
      file_id: 'embedded-file',
      filepath: '/uploads/embedded.txt',
      source: FileSources.local,
      embedded: true,
    };

    const result = await processDeleteRequest({ req, files: [file] });

    expect(primaryDelete).toHaveBeenCalledWith(req, file, undefined);
    expect(vectorDelete).not.toHaveBeenCalled();
    expect(db.deleteFiles).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedFileIds: [], failedFileIds: ['embedded-file'] });
  });

  it('still deletes vector storage when primary embedded file storage is already missing', async () => {
    const missingError = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const primaryDelete = jest.fn().mockRejectedValue(missingError);
    const vectorDelete = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockImplementation((source) =>
      source === FileSources.vectordb
        ? { deleteFile: vectorDelete }
        : { deleteFile: primaryDelete },
    );
    db.deleteFiles.mockResolvedValue({ deletedCount: 1 });
    const req = {
      body: {},
      config: {},
      user: { id: 'user-123', tenantId: 'tenant-a' },
    };
    const file = {
      file_id: 'embedded-file',
      filepath: '/uploads/embedded.txt',
      source: FileSources.local,
      embedded: true,
    };

    const result = await processDeleteRequest({ req, files: [file] });

    expect(primaryDelete).toHaveBeenCalledWith(req, file, undefined);
    expect(vectorDelete).toHaveBeenCalledWith(req, file);
    expect(db.deleteFiles).toHaveBeenCalledWith(['embedded-file']);
    expect(result).toEqual({ deletedFileIds: ['embedded-file'], failedFileIds: [] });
  });

  it('deletes code environment storage before removing code resource file metadata', async () => {
    const primaryDelete = jest.fn().mockResolvedValue(undefined);
    const codeDelete = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockImplementation((source) =>
      source === FileSources.execute_code
        ? { deleteFile: codeDelete }
        : { deleteFile: primaryDelete },
    );
    db.deleteFiles.mockResolvedValue({ deletedCount: 1 });
    const req = {
      body: {},
      config: {},
      user: { id: 'user-123', tenantId: 'tenant-a' },
    };
    const file = {
      file_id: 'code-resource-file',
      filepath: '/uploads/code-resource.txt',
      source: FileSources.local,
      metadata: {
        codeEnvRef: {
          kind: 'agent',
          id: 'agent-abc',
          storage_session_id: 'sess-1',
          file_id: 'fid-1',
        },
      },
    };

    const result = await processDeleteRequest({ req, files: [file] });

    expect(primaryDelete).toHaveBeenCalledWith(req, file, undefined);
    expect(codeDelete).toHaveBeenCalledWith(req, file);
    expect(db.deleteFiles).toHaveBeenCalledWith(['code-resource-file']);
    expect(result).toEqual({ deletedFileIds: ['code-resource-file'], failedFileIds: [] });
  });
});

describe('sweepExpiredFiles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates expired file sweeping to the shared package with backend dependencies', async () => {
    const options = {
      appConfig: { paths: { publicPath: '/tmp/public', uploads: '/tmp/uploads' } },
      limit: 1,
    };
    sweepExpiredFilesWithDeps.mockResolvedValue({ scanned: 1, deleted: 1, failed: 0 });

    const result = await sweepExpiredFiles(options);

    expect(sweepExpiredFilesWithDeps).toHaveBeenCalledWith(
      options,
      expect.objectContaining({
        getExpiredFiles: db.getExpiredFiles,
        processDeleteRequest: expect.any(Function),
        logger: expect.objectContaining({
          error: expect.any(Function),
          info: expect.any(Function),
          warn: expect.any(Function),
        }),
      }),
    );
    expect(result).toEqual({ scanned: 1, deleted: 1, failed: 0 });
  });
});

describe('startExpiredFileSweep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates background sweep startup to the shared package with system context', () => {
    const options = {
      appConfig: { paths: { publicPath: '/tmp/public', uploads: '/tmp/uploads' } },
    };

    const interval = startExpiredFileSweep(options);

    expect(startExpiredFileSweepWithDeps).toHaveBeenCalledWith(
      options,
      expect.objectContaining({
        sweepExpiredFiles: expect.any(Function),
        runAsSystem: expect.any(Function),
        logger: expect.objectContaining({
          error: expect.any(Function),
          info: expect.any(Function),
          warn: expect.any(Function),
        }),
      }),
    );
    expect(interval).toBe('sweep-interval');
  });
});

// [knauf] filterFile per-category size caps (KK20-190). Documents 25 / data 50 /
// images 20 MB, enforced on top of the endpoint fileSizeLimit, scoped to the
// endpoints that carry the Knauf allow-list (azureOpenAI + agents) and skipped
// for avatars. Endpoint fileSizeLimit is set high here so the per-category cap is
// what fires.
describe('filterFile per-category size caps', () => {
  const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';
  const MB = 1024 * 1024;

  const makeCappedConfig = () => ({
    checkType: () => true,
    endpoints: {
      default: { fileSizeLimit: 200 * MB, supportedMimeTypes: [/.*/] },
      azureOpenAI: { fileSizeLimit: 200 * MB, supportedMimeTypes: [/.*/] },
      agents: { fileSizeLimit: 200 * MB, supportedMimeTypes: [/.*/] },
    },
  });

  const makeFilterReq = ({
    endpoint = 'azureOpenAI',
    mimetype = PDF_MIME,
    size,
    tool_resource,
  }) => ({
    user: { id: 'user-123' },
    file: { path: '/tmp/upload.bin', originalname: 'u.bin', filename: 'u.bin', mimetype, size },
    body: { endpoint, file_id: VALID_UUID, tool_resource },
    config: { fileConfig: {}, fileStrategy: 'local' },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mergeFileConfig.mockReturnValue(makeCappedConfig());
  });

  test('throws the document key for a PDF over 25 MB on azureOpenAI', () => {
    const req = makeFilterReq({ endpoint: 'azureOpenAI', mimetype: PDF_MIME, size: 30 * MB });
    expect(() => filterFile({ req })).toThrow('com_knauf_error_file_too_large_document');
  });

  test('throws the data key for an XLSX over 50 MB on agents', () => {
    const req = makeFilterReq({ endpoint: 'agents', mimetype: XLSX_MIME, size: 60 * MB });
    expect(() => filterFile({ req })).toThrow('com_knauf_error_file_too_large_data');
  });

  test('throws the image key for a PNG over 20 MB on azureOpenAI', () => {
    const req = makeFilterReq({ endpoint: 'azureOpenAI', mimetype: 'image/png', size: 26 * MB });
    expect(() => filterFile({ req })).toThrow('com_knauf_error_file_too_large_image');
  });

  test('allows a PDF exactly at the 25 MB cap (strict > boundary)', () => {
    const req = makeFilterReq({ endpoint: 'azureOpenAI', mimetype: PDF_MIME, size: 25 * MB });
    expect(() => filterFile({ req })).not.toThrow();
  });

  test('does NOT apply the per-category cap on a non-Knauf endpoint (B3 scope)', () => {
    const req = makeFilterReq({ endpoint: 'bedrock', mimetype: PDF_MIME, size: 30 * MB });
    expect(() => filterFile({ req })).not.toThrow();
  });

  test('skips the per-category cap for avatars', () => {
    const req = makeFilterReq({ endpoint: 'azureOpenAI', mimetype: PDF_MIME, size: 30 * MB });
    expect(() => filterFile({ req, isAvatar: true })).not.toThrow();
  });

  // The data cap (50 MB) equals the production endpoint fileSizeLimit (50 MB). The
  // per-category cap must be authoritative so a file exactly at 50 MB is allowed and
  // the generic endpoint check is skipped — keeping the boundary + message in lockstep
  // with the client (validateFiles). KK20-190.
  const makeFiftyMbConfig = () => ({
    checkType: () => true,
    endpoints: {
      default: { fileSizeLimit: 50 * MB, supportedMimeTypes: [/.*/] },
      azureOpenAI: { fileSizeLimit: 50 * MB, supportedMimeTypes: [/.*/] },
      agents: { fileSizeLimit: 50 * MB, supportedMimeTypes: [/.*/] },
    },
  });

  test('allows an XLSX exactly at the 50 MB data cap even when it equals fileSizeLimit', () => {
    mergeFileConfig.mockReturnValue(makeFiftyMbConfig());
    const req = makeFilterReq({ endpoint: 'azureOpenAI', mimetype: XLSX_MIME, size: 50 * MB });
    expect(() => filterFile({ req })).not.toThrow();
  });

  test('throws the localized category key (not the generic message) when a capped file exceeds fileSizeLimit', () => {
    mergeFileConfig.mockReturnValue(makeFiftyMbConfig());
    const req = makeFilterReq({ endpoint: 'azureOpenAI', mimetype: PDF_MIME, size: 60 * MB });
    expect(() => filterFile({ req })).toThrow('com_knauf_error_file_too_large_document');
  });

  // Server backstop: a file_search (agent-knowledge) upload follows the per-category
  // caps even when the agent's model-provider endpoint is NOT azureOpenAI/agents, so a
  // mis-sent endpoint can't bypass the size caps. KK20-190.
  test('applies the per-category cap to a file_search upload on a non-Knauf endpoint', () => {
    const req = makeFilterReq({
      endpoint: 'bedrock',
      mimetype: PDF_MIME,
      size: 30 * MB,
      tool_resource: EToolResources.file_search,
    });
    expect(() => filterFile({ req })).toThrow('com_knauf_error_file_too_large_document');
  });
});

// [knauf] filterFile actionable rejection for off-allow-list types (KK20-190). When
// the endpoint's restricted allow-list rejects the mime, the Knauf endpoints throw
// an actionable i18n key (legacy-Office Save-As help, or a friendly unsupported-type
// message); other endpoints keep the upstream generic 'Unsupported file type'.
describe('filterFile legacy-Office / unsupported-type rejection', () => {
  const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';
  const MB = 1024 * 1024;

  // Restrictive allow-list (only PDF) so off-list types hit the !isSupportedMimeType
  // branch — mirrors the production librechat.yaml &knauf_allowed_mime behavior.
  const makeRestrictiveConfig = () => ({
    checkType: (mime, types) => (types || []).some((re) => re.test(mime)),
    endpoints: {
      default: { fileSizeLimit: 200 * MB, supportedMimeTypes: [/^application\/pdf$/] },
      azureOpenAI: { fileSizeLimit: 200 * MB, supportedMimeTypes: [/^application\/pdf$/] },
      agents: { fileSizeLimit: 200 * MB, supportedMimeTypes: [/^application\/pdf$/] },
      bedrock: { fileSizeLimit: 200 * MB, supportedMimeTypes: [/^application\/pdf$/] },
    },
  });

  const makeReq = ({ endpoint = 'azureOpenAI', mimetype, originalname }) => ({
    user: { id: 'user-123' },
    file: { path: '/tmp/upload.bin', originalname, filename: originalname, mimetype, size: 1024 },
    body: { endpoint, file_id: VALID_UUID },
    config: { fileConfig: {}, fileStrategy: 'local' },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mergeFileConfig.mockReturnValue(makeRestrictiveConfig());
  });

  test('throws the legacy-Office key for a legacy .xls on azureOpenAI', () => {
    const req = makeReq({ endpoint: 'azureOpenAI', mimetype: XLS_MIME, originalname: 'sheet.xls' });
    expect(() => filterFile({ req })).toThrow('com_knauf_error_legacy_xls');
  });

  test('throws the friendly unsupported-type key for an unknown type on agents', () => {
    const req = makeReq({
      endpoint: 'agents',
      mimetype: 'application/x-unknown',
      originalname: 'data.xyz',
    });
    expect(() => filterFile({ req })).toThrow('com_knauf_error_unsupported_type');
  });

  test('keeps the upstream generic message on a non-Knauf endpoint', () => {
    const req = makeReq({ endpoint: 'bedrock', mimetype: XLS_MIME, originalname: 'sheet.xls' });
    expect(() => filterFile({ req })).toThrow('Unsupported file type');
  });
});
// End [knauf]

// [knauf] KK20-203 — seam test: chat file_search uploads stamp the originating
// conversationId on the File record so chat deletion can cascade-clean them.
describe('processAgentFileUpload conversationId stamp (KK20-203)', () => {
  const db = require('~/models');

  const fileSearchMeta = () => ({
    agent_id: 'agent-abc',
    tool_resource: EToolResources.file_search,
    file_id: 'fid-1',
    message_file: 'true', // chat attachment (the conversationId stamp applies to this path)
  });
  const fileSearchReq = (conversationId) => ({
    user: { id: 'user-123' },
    file: { path: '/tmp/u.pdf', originalname: 'doc.pdf', filename: 'u.pdf', mimetype: PDF_MIME },
    body: { model: 'gpt-4o', conversationId },
    config: { fileConfig: {}, fileStrategy: 'local' },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    checkCapability.mockResolvedValue(true);
    mergeFileConfig.mockReturnValue(makeFileConfig());
    getStrategyFunctions.mockReturnValue({
      handleFileUpload: jest
        .fn()
        .mockResolvedValue({ bytes: 10, filename: 'doc.pdf', filepath: '/blob/doc.pdf' }),
    });
  });

  test('stamps the conversationId on the created File', async () => {
    await processAgentFileUpload({
      req: fileSearchReq('convo-xyz'),
      res: mockRes,
      metadata: fileSearchMeta(),
    });
    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'convo-xyz' }),
      true,
      { userId: 'user-123', tenantId: null },
    );
  });

  test('omits the conversationId for the NEW_CONVO sentinel', async () => {
    await processAgentFileUpload({
      req: fileSearchReq('new'),
      res: mockRes,
      metadata: fileSearchMeta(),
    });
    const fileInfo = db.createFile.mock.calls.at(-1)[0];
    expect(fileInfo.conversationId).toBeUndefined();
  });
});
// End [knauf]

// [knauf] KK20-204 → KK20-195 WP3b — per-user content-hash dedup on the
// file_search upload path, now expressed as the reservation-first FileAsset
// lifecycle: reserve (dedup_key = scope + hash) BEFORE any physical work;
// created → blob + markQueued + sync claim→embed→activate; found → branch table.
describe('processAgentFileUpload content-hash dedup (KK20-204/KK20-195)', () => {
  const { computeContentHash } = require('~/server/services/Files/knauf/contentDedup');
  const db = require('~/models');
  const handleFileUpload = jest
    .fn()
    .mockResolvedValue({ bytes: 10, filename: 'doc.pdf', filepath: '/blob/doc.pdf' });

  // Personal chat attachment (message_file) — the only path that per-user dedups.
  const fsMeta = () => ({
    agent_id: 'agent-abc',
    tool_resource: EToolResources.file_search,
    file_id: 'up-1',
    message_file: 'true',
  });
  const fsReq = () => ({
    user: { id: 'user-123' },
    file: { path: '/tmp/u.pdf', originalname: 'doc.pdf', filename: 'u.pdf', mimetype: PDF_MIME },
    body: { model: 'gpt-4o', conversationId: 'convo-x' },
    config: { fileConfig: {}, fileStrategy: 'local' },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    checkCapability.mockResolvedValue(true);
    mergeFileConfig.mockReturnValue(makeFileConfig());
    getStrategyFunctions.mockReturnValue({ handleFileUpload });
    computeContentHash.mockResolvedValue('hashABC');
  });

  test('MISS — reserves the asset by scope+hash, uploads + embeds USER-owned, records the lifecycle', async () => {
    await processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() });

    // Reservation happens BEFORE physical work, keyed by user scope + hash.
    expect(db.reserveAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        asset_id: 'mock-uuid',
        scope_type: 'user',
        scope_id: 'user-123',
        dedup_key: 'u:user-123:h:hashABC',
        embed_route: '/embed',
      }),
    );
    expect(handleFileUpload).toHaveBeenCalledTimes(1); // storage upload happened
    expect(handleFileUpload).toHaveBeenCalledWith(
      expect.objectContaining({ file_id: 'mock-uuid' }),
    );
    expect(db.markQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        asset_id: 'mock-uuid',
        blob: expect.objectContaining({ filename: 'doc.pdf' }),
      }),
    );
    expect(mockEmbedGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        asset_id: 'mock-uuid',
        generation: 1,
        embed_route: '/embed',
        scope: { userId: 'user-123', entityId: 'user-123' },
      }),
    );
    // Sync (flag-off) execution is recorded through the asset: claim → activate.
    expect(db.claimAsset).toHaveBeenCalledWith(expect.objectContaining({ asset_id: 'mock-uuid' }));
    expect(db.activateGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ asset_id: 'mock-uuid', execution_token: 'test-token' }),
    );
    const fileInfo = db.createFile.mock.calls.at(-1)[0];
    expect(fileInfo.knauf_content_hash).toBe('hashABC');
    expect(fileInfo.knauf_asset_id).toBe('mock-uuid');
    expect(fileInfo.knauf_dedup_owner).toBe(true); // claims the unique owner slot
    expect(fileInfo.knauf_upload_finalized).toBe(true);
  });

  test('generation-safe synchronous embed retries a provider throttle', async () => {
    mockEmbedGeneration
      .mockRejectedValueOnce({ response: { status: 429, headers: { 'retry-after': '0' } } })
      .mockResolvedValueOnce({ status: 'ready' });
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      await processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() });
    } finally {
      random.mockRestore();
    }

    expect(mockEmbedGeneration).toHaveBeenCalledTimes(2);
    expect(recordFileIndexProviderError).toHaveBeenCalledWith('embed', '429');
    expect(recordFileIndexEmbedRetry).toHaveBeenCalledWith('embed');
    expect(recordFileIndexEmbed).toHaveBeenCalledWith('embed', 'success', expect.any(Number));
  });

  test('generation-safe synchronous embed safely retries an HTTP timeout', async () => {
    mockEmbedGeneration
      .mockRejectedValueOnce({ response: { status: 408 } })
      .mockResolvedValueOnce({ status: 'ready' });
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      await processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() });
    } finally {
      random.mockRestore();
    }

    expect(mockEmbedGeneration).toHaveBeenCalledTimes(2);
    expect(recordFileIndexEmbedRetry).toHaveBeenCalledWith('embed');
  });

  test('concurrent owner race — duplicate-key on insert → falls back to a non-owner row', async () => {
    // KK20-195 review F3 — call 0 is the pending File marker. The
    // FINAL owner createFile hits the unique-owner index collision; its retry
    // succeeds as a non-owner.
    const dupErr = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    db.createFile
      .mockResolvedValueOnce({ file_id: 'up-1' }) // pending marker (F3)
      .mockRejectedValueOnce(dupErr) // final owner attempt → collision
      .mockResolvedValueOnce({ file_id: 'up-1' }); // retry as a non-owner duplicate

    await processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() });

    expect(db.createFile).toHaveBeenCalledTimes(3);
    const pending = db.createFile.mock.calls[0][0];
    const ownerAttempt = db.createFile.mock.calls[1][0];
    const retry = db.createFile.mock.calls[2][0];
    expect(pending.knauf_dedup_owner).toBe(true); // ownership is durable before physical work
    expect(pending.knauf_content_hash).toBe('hashABC');
    expect(pending.knauf_upload_finalized).toBe(false);
    expect(pending.embedded).toBe(false); // in-flight until the final upsert
    expect(ownerAttempt.knauf_dedup_owner).toBe(true); // final row tries to own
    expect(retry.knauf_dedup_owner).toBeUndefined(); // retried as a non-owner duplicate
    expect(retry.knauf_asset_id).toBe('mock-uuid');
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.any(String) }),
    );
  });

  // KK20-195 review F3 (re-review) — the crash-recovery anchor: a pending File is
  // persisted BEFORE any physical work, so process death at either boundary
  // (after the blob store, or after markQueued) leaves a user-visible, retryable
  // File that references the asset — never a queued asset with no File.
  test('F3: persists a pending File BEFORE physical work, referencing the asset', async () => {
    const order = [];
    handleFileUpload.mockImplementationOnce(async () => {
      order.push('blob');
      return { bytes: 10, filename: 'doc.pdf', filepath: '/blob/doc.pdf' };
    });
    db.createFile.mockImplementation(async (info) => {
      order.push(info.embedded === false ? 'pending' : 'final');
      return { file_id: 'up-1' };
    });

    await processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() });

    expect(order[0]).toBe('pending'); // written first, before the blob store
    expect(order.indexOf('pending')).toBeLessThan(order.indexOf('blob'));
    const pending = db.createFile.mock.calls[0][0];
    expect(pending.embedded).toBe(false);
    expect(pending.knauf_asset_id).toBe('mock-uuid'); // references the physical asset from the start
    expect(pending.knauf_dedup_owner).toBe(true);
    expect(pending.knauf_content_hash).toBe('hashABC');
    expect(pending.knauf_upload_finalized).toBe(false);
  });

  test('persists the deterministic Azure blob intent before streaming bytes', async () => {
    const { getFileStrategy } = require('~/server/utils/getFileStrategy');
    const getFileURL = jest
      .fn()
      .mockResolvedValue('https://storage.example/files/images/user-123/mock-uuid__u.pdf?sig=test');
    getFileStrategy.mockReturnValueOnce('azure_blob');
    getStrategyFunctions.mockReturnValue({ handleFileUpload, getFileURL });

    await processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() });

    expect(getFileURL).toHaveBeenCalledWith({
      fileName: 'mock-uuid__u.pdf',
      basePath: 'uploads',
      userId: 'user-123',
    });
    expect(db.createFile.mock.calls[0][0].filepath).toContain('mock-uuid__u.pdf');
    expect(handleFileUpload).toHaveBeenCalledWith(
      expect.objectContaining({ file_id: 'mock-uuid' }),
    );
  });

  test('fails before physical work when the pending File cannot be persisted', async () => {
    db.createFile.mockRejectedValueOnce(new Error('mongo down at pending marker'));

    await expect(
      processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() }),
    ).rejects.toThrow('mongo down at pending marker');

    expect(handleFileUpload).not.toHaveBeenCalled();
    expect(db.tombstoneForDelete).toHaveBeenCalledWith({ asset_id: 'mock-uuid' });
    expect(db.removeAsset).toHaveBeenCalledWith({ asset_id: 'mock-uuid' });
  });

  test('retries a transient duplicate-key race while persisting the pending File', async () => {
    const duplicateKey = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    db.createFile
      .mockRejectedValueOnce(duplicateKey)
      .mockResolvedValueOnce({ file_id: 'up-1' })
      .mockResolvedValueOnce({ file_id: 'up-1' });

    await processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() });

    expect(db.createFile).toHaveBeenCalledTimes(3);
    expect(db.createFile.mock.calls[1]).toEqual(db.createFile.mock.calls[0]);
    expect(handleFileUpload).toHaveBeenCalledTimes(1);
  });

  test('compensates the blob when its durable File intent cannot be recorded', async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockReturnValue({ handleFileUpload, deleteFile });
    db.updateFile.mockRejectedValueOnce(new Error('mongo down at blob intent'));

    await expect(
      processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() }),
    ).rejects.toThrow('mongo down at blob intent');

    expect(deleteFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filepath: '/blob/doc.pdf', embedded: false }),
    );
    expect(db.removeAsset).toHaveBeenCalledWith({ asset_id: 'mock-uuid' });
    expect(db.deleteFiles).toHaveBeenCalledWith(['up-1']);
  });

  test('keeps the asset and pending File when blob compensation fails', async () => {
    const deleteFile = jest.fn().mockRejectedValue(new Error('blob store unavailable'));
    getStrategyFunctions.mockReturnValue({ handleFileUpload, deleteFile });
    db.markQueued.mockRejectedValueOnce(new Error('mongo down after blob upload'));

    await expect(
      processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() }),
    ).rejects.toThrow('mongo down after blob upload');

    expect(deleteFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ file_id: 'mock-uuid', filepath: '/blob/doc.pdf' }),
    );
    expect(db.tombstoneForDelete).toHaveBeenCalledWith({ asset_id: 'mock-uuid' });
    expect(db.markDeleteFailed).toHaveBeenCalledWith({
      asset_id: 'mock-uuid',
      error_code: 'blob_cleanup_failed',
    });
    expect(db.removeAsset).not.toHaveBeenCalled();
    expect(db.deleteFiles).not.toHaveBeenCalled();
  });

  test('F3: a createFile failure after queueing leaves the pending File as a recovery anchor', async () => {
    // The pending marker succeeds; the FINAL createFile (after markQueued + embed)
    // throws — modeling a crash while finalizing. The pending File + queued asset
    // survive, so the upload stays user-visible/retryable instead of becoming a
    // queued asset with no File.
    db.createFile
      .mockResolvedValueOnce({ file_id: 'up-1' }) // pending marker
      .mockRejectedValueOnce(new Error('mongo down at finalize')); // final row

    await expect(
      processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() }),
    ).rejects.toThrow('mongo down at finalize');

    expect(db.markQueued).toHaveBeenCalledWith(expect.objectContaining({ asset_id: 'mock-uuid' }));
    expect(db.createFile.mock.calls[0][0].embedded).toBe(false); // the pending marker persisted
    // The pending File is the recovery anchor — a finalize failure must NOT delete it.
    expect(db.deleteFiles).not.toHaveBeenCalled();
  });

  test('preserves the lifecycle when the explicit post-queue claim is lost', async () => {
    db.claimAsset.mockResolvedValueOnce(null);

    await expect(
      processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() }),
    ).rejects.toThrow('file_indexing_in_progress');

    expect(db.markQueued).toHaveBeenCalled();
    expect(mockEmbedGeneration).not.toHaveBeenCalled();
    expect(db.tombstoneForDelete).not.toHaveBeenCalled();
    expect(db.removeAsset).not.toHaveBeenCalled();
    expect(db.deleteFiles).not.toHaveBeenCalled();
  });

  const readyAsset = () => ({
    asset_id: 'canon-1',
    status: 'ready',
    active_generation: 0,
    active_index_profile: 'legacy-v0',
    blob: { source: 'local', path: '/blob/canon', bytes: 5, mime: PDF_MIME },
  });

  test('HIT — reuses the shared asset blob + embeddings; skips upload + embed', async () => {
    db.reserveAsset.mockResolvedValueOnce({ created: false, asset: readyAsset() });
    db.getAssetByAssetId.mockResolvedValueOnce(readyAsset());
    await processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() });

    expect(handleFileUpload).not.toHaveBeenCalled(); // no storage upload
    expect(mockEmbedGeneration).not.toHaveBeenCalled(); // no embed
    const fileInfo = db.createFile.mock.calls.at(-1)[0];
    expect(fileInfo.knauf_asset_id).toBe('canon-1'); // reuse row points at the shared asset
    expect(fileInfo.filepath).toBe('/blob/canon'); // reuses the shared blob
    expect(fileInfo.knauf_content_hash).toBe('hashABC');
    expect(fileInfo.embedded).toBe(true);
    expect(fileInfo.knauf_upload_finalized).toBe(true);
    expect(db.createFile.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        file_id: 'up-1',
        knauf_asset_id: 'canon-1',
        embedded: false,
        knauf_upload_finalized: false,
      }),
    );
  });

  test('cross-chat — same content uploaded in another of the user’s chats reuses the asset', async () => {
    // Different chat (message attachment), same user + content → HIT, no re-embed.
    db.reserveAsset.mockResolvedValueOnce({ created: false, asset: readyAsset() });
    db.getAssetByAssetId.mockResolvedValueOnce(readyAsset());

    await processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() });

    const fileInfo = db.createFile.mock.calls.at(-1)[0];
    expect(fileInfo.knauf_asset_id).toBe('canon-1'); // reuse row points at the shared asset
    expect(handleFileUpload).not.toHaveBeenCalled(); // no re-upload/embed
    expect(mockEmbedGeneration).not.toHaveBeenCalled();
  });

  test('ready reuse aborts when a concurrent last-reference delete tombstones the asset', async () => {
    db.reserveAsset.mockResolvedValueOnce({ created: false, asset: readyAsset() });
    db.getAssetByAssetId.mockResolvedValueOnce({
      ...readyAsset(),
      status: 'deleting',
      delete_requested_at: new Date(),
    });

    await processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() });

    expect(db.createFile).toHaveBeenCalledTimes(1); // pending reference only
    expect(db.deleteFiles).toHaveBeenCalledWith(['up-1']);
    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'file_asset_conflict',
      file_id: 'up-1',
    });
    expect(handleFileUpload).not.toHaveBeenCalled();
    expect(mockEmbedGeneration).not.toHaveBeenCalled();
  });

  test('in-progress asset — stable 409 conflict, no duplicate physical work (WP3b)', async () => {
    db.reserveAsset.mockResolvedValueOnce({
      created: false,
      asset: { asset_id: 'canon-1', status: 'processing' },
    });

    await processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() });

    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'file_indexing_in_progress',
      file_id: 'up-1',
    });
    expect(handleFileUpload).not.toHaveBeenCalled();
    expect(mockEmbedGeneration).not.toHaveBeenCalled();
    expect(db.createFile).not.toHaveBeenCalled();
  });

  test('stale processing replay resumes the same physical asset without deleting its blob', async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockReturnValue({ handleFileUpload, deleteFile });
    db.reserveAsset.mockResolvedValueOnce({
      created: false,
      asset: {
        asset_id: 'stale-physical-1',
        status: 'processing',
        lease_expires_at: new Date(0),
        vector_backend: 'pgvector',
        blob: {
          source: 'local',
          path: '/blob/stale.pdf',
          bytes: 10,
          filename: 'doc.pdf',
        },
      },
    });

    await processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() });

    expect(handleFileUpload).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
    expect(db.removeAsset).not.toHaveBeenCalled();
    expect(mockEmbedGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        asset_id: 'stale-physical-1',
        blob: expect.objectContaining({ path: '/blob/stale.pdf' }),
      }),
    );
    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({ knauf_asset_id: 'stale-physical-1', embedded: true }),
      true,
      { userId: 'user-123', tenantId: null },
    );
  });

  test('async acceptance flag ON — 202 + indexing projection, no in-request embed (WP3b)', async () => {
    process.env.KNAUF_ASYNC_FILE_INDEXING_ACCEPT = 'true';
    try {
      const queuedAt = new Date('2026-07-16T00:00:00.000Z');
      db.getAssetByAssetId.mockResolvedValueOnce({
        asset_id: 'mock-uuid',
        status: 'queued',
        active_generation: null,
        queued_at: queuedAt,
      });

      await processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() });

      expect(handleFileUpload).toHaveBeenCalledTimes(1); // blob IS uploaded
      expect(db.markQueued).toHaveBeenCalled(); // durable state exists
      expect(mockEmbedGeneration).not.toHaveBeenCalled(); // the worker embeds, not this request
      expect(db.claimAsset).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(202);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          indexing: {
            status: 'queued',
            ready: false,
            retryable: false,
            error_code: null,
            queued_at: queuedAt,
          },
        }),
      );
      const fileInfo = db.createFile.mock.calls.at(-1)[0];
      expect(fileInfo.embedded).toBe(false); // flips on generation activation (WP4)
    } finally {
      delete process.env.KNAUF_ASYNC_FILE_INDEXING_ACCEPT;
    }
  });

  test('async acceptance over the backlog cap — 429, reservation compensated (WP3c/R7)', async () => {
    process.env.KNAUF_ASYNC_FILE_INDEXING_ACCEPT = 'true';
    process.env.KNAUF_INDEX_MAX_QUEUED_FILES = '2';
    try {
      // R7 reserve-then-recheck: the count INCLUDES this request's own
      // reservation (3 - self = 2 effective ≥ cap 2 → rejected).
      db.countActiveByScope.mockResolvedValueOnce(3);

      await processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() });

      expect(mockRes.status).toHaveBeenCalledWith(429);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'file_indexing_backlog_full',
        reason: 'queued_files',
        file_id: 'up-1',
      });
      // The reservation was made (that's what defeats the TOCTOU race) and
      // then compensated — nothing durable survives the rejection.
      expect(db.reserveAsset).toHaveBeenCalledTimes(1);
      expect(db.tombstoneForDelete).toHaveBeenCalledWith({ asset_id: 'mock-uuid' });
      expect(db.removeAsset).toHaveBeenCalledWith({ asset_id: 'mock-uuid' });
      expect(handleFileUpload).not.toHaveBeenCalled(); // no physical work
      expect(db.createFile).not.toHaveBeenCalled();
    } finally {
      delete process.env.KNAUF_ASYNC_FILE_INDEXING_ACCEPT;
      delete process.env.KNAUF_INDEX_MAX_QUEUED_FILES;
    }
  });

  // KK20-195 review R3 — kill-point tests around blob upload → queue
  // transition. (The die-AFTER-markQueued boundary is covered by the reclaim
  // test in fileSearchAssetLifecycle.spec and the worker scope-retry test —
  // the asset is queued and recoverable there; here nothing durable may
  // survive.)
  test('kill-point: markQueued THROWS after the blob landed → blob compensated, reservation released (R3)', async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockReturnValue({ handleFileUpload, deleteFile });
    db.markQueued.mockRejectedValueOnce(new Error('mongo down'));

    await expect(
      processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() }),
    ).rejects.toThrow('mongo down');

    // The uploaded blob is deleted — not orphaned with only the ledger row gone.
    expect(deleteFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filepath: '/blob/doc.pdf', embedded: false }),
    );
    expect(db.tombstoneForDelete).toHaveBeenCalledWith({ asset_id: 'mock-uuid' });
    expect(db.removeAsset).toHaveBeenCalledWith({ asset_id: 'mock-uuid' });
    // KK20-195 review F3 — a pending File marker is written before physical work.
    // A HANDLED failure compensates it (the marker only survives PROCESS DEATH,
    // by design), so the request still leaves nothing behind.
    expect(db.createFile).toHaveBeenCalledTimes(1);
    expect(db.createFile.mock.calls[0][0].embedded).toBe(false); // it was the pending marker
    expect(db.deleteFiles).toHaveBeenCalledWith(['up-1']);
  });

  test('kill-point: markQueued CAS MISS (null) is the same failure as a throw (R3)', async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockReturnValue({ handleFileUpload, deleteFile });
    db.markQueued.mockResolvedValueOnce(null); // concurrent tombstone won the CAS

    await expect(
      processAgentFileUpload({ req: fsReq(), res: mockRes, metadata: fsMeta() }),
    ).rejects.toThrow('file_asset_queue_transition_lost');

    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(db.removeAsset).toHaveBeenCalledWith({ asset_id: 'mock-uuid' });
    // F3 — the pending File marker is compensated on the handled failure.
    expect(db.createFile).toHaveBeenCalledTimes(1);
    expect(db.deleteFiles).toHaveBeenCalledWith(['up-1']);
  });
});
// End [knauf]

// [knauf] KK20-204 — agent-library file_search uploads (added to a persistent agent's
// knowledge in the builder; EDIT-permission gated upstream) embed AGENT-scoped so every
// user with access to the agent can retrieve them, and are NOT per-user deduped.
describe('processAgentFileUpload agent-library file_search (KK20-204 sharing)', () => {
  const { computeContentHash } = require('~/server/services/Files/knauf/contentDedup');
  const db = require('~/models');
  const handleFileUpload = jest
    .fn()
    .mockResolvedValue({ bytes: 10, filename: 'kb.pdf', filepath: '/blob/kb.pdf' });

  // No message_file ⇒ agent-library (builder) upload, NOT a chat attachment.
  const libMeta = () => ({
    agent_id: 'agent-abc',
    tool_resource: EToolResources.file_search,
    file_id: 'lib-1',
  });
  const libReq = () => ({
    user: { id: 'user-123' },
    file: { path: '/tmp/kb.pdf', originalname: 'kb.pdf', filename: 'kb.pdf', mimetype: PDF_MIME },
    body: { model: 'gpt-4o' },
    config: { fileConfig: {}, fileStrategy: 'local' },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    checkCapability.mockResolvedValue(true);
    mergeFileConfig.mockReturnValue(makeFileConfig());
    getStrategyFunctions.mockReturnValue({ handleFileUpload });
    computeContentHash.mockResolvedValue('agentHashABC');
  });

  test('embeds AGENT-scoped, skips per-user dedup, and adds to the agent library', async () => {
    await processAgentFileUpload({ req: libReq(), res: mockRes, metadata: libMeta() });

    // No dedup work on the library path — but the physical asset IS reserved
    // (KK20-195 WP3b: every file_search upload records its lifecycle),
    // agent-scoped and WITHOUT a dedup key (same content ⇒ separate assets).
    expect(computeContentHash).toHaveBeenCalledWith('/tmp/kb.pdf');
    expect(db.reserveAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        asset_id: 'mock-uuid',
        scope_type: 'agent',
        scope_id: 'agent-abc',
        embed_route: '/agent/embed',
        dedup_key: undefined,
      }),
    );
    // Embedded AGENT-scoped → readable by everyone with access to the agent.
    expect(mockEmbedGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        asset_id: 'mock-uuid',
        generation: 1,
        embed_route: '/agent/embed',
        scope: { userId: 'user-123', entityId: 'agent-abc' },
      }),
    );
    // Row carries no dedup bookkeeping (dropped by removeNullishValues), but
    // points at its immutable physical asset for status + delete refcount.
    const fileInfo = db.createFile.mock.calls.at(-1)[0];
    expect(fileInfo.knauf_content_hash).toBe('agentHashABC');
    expect(fileInfo.knauf_asset_id).toBe('mock-uuid');
    expect(fileInfo.knauf_dedup_owner).toBeUndefined();
    // Added to the agent's persistent file_search library.
    expect(db.addAgentResourceFile).toHaveBeenCalled();
  });

  test('repairs an incomplete agent-library finalization using the existing ready asset', async () => {
    const req = { ...libReq(), knaufRecoverAssetId: 'ready-lib-asset' };
    db.getAssetByAssetId.mockResolvedValue({
      asset_id: 'ready-lib-asset',
      status: 'ready',
      active_generation: 1,
      active_index_profile: 'legacy-v0',
      scope_type: 'agent',
      scope_id: 'agent-abc',
      blob: { source: 'local', path: '/blob/ready-kb.pdf', bytes: 10, mime: PDF_MIME },
    });

    await processAgentFileUpload({ req, res: mockRes, metadata: libMeta() });

    expect(db.reserveAsset).not.toHaveBeenCalled();
    expect(handleFileUpload).not.toHaveBeenCalled();
    expect(mockEmbedGeneration).not.toHaveBeenCalled();
    expect(db.addAgentResourceFile).toHaveBeenCalledWith({
      file_id: 'lib-1',
      agent_id: 'agent-abc',
      tool_resource: EToolResources.file_search,
      updatingUserId: 'user-123',
    });
    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        file_id: 'lib-1',
        filepath: '/blob/ready-kb.pdf',
        embedded: true,
        knauf_asset_id: 'ready-lib-asset',
        knauf_upload_finalized: true,
      }),
      true,
      { userId: 'user-123', tenantId: null },
    );
  });

  test('resumes a stale agent-library generation on the handed-off physical asset', async () => {
    const req = { ...libReq(), knaufRecoverAssetId: 'stale-lib-asset' };
    db.getAssetByAssetId.mockResolvedValue({
      asset_id: 'stale-lib-asset',
      status: 'processing',
      lease_expires_at: new Date(0),
      vector_backend: 'azure_search',
      scope_type: 'agent',
      scope_id: 'agent-abc',
      blob: {
        source: 'local',
        path: '/blob/stale-kb.pdf',
        bytes: 10,
        mime: PDF_MIME,
        filename: 'kb.pdf',
      },
    });

    await processAgentFileUpload({ req, res: mockRes, metadata: libMeta() });

    expect(db.reserveAsset).not.toHaveBeenCalled();
    expect(handleFileUpload).not.toHaveBeenCalled();
    expect(mockEmbedGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        asset_id: 'stale-lib-asset',
        generation: 1,
        embed_route: '/agent/embed',
        blob: expect.objectContaining({ path: '/blob/stale-kb.pdf' }),
      }),
    );
    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        file_id: 'lib-1',
        embedded: true,
        knauf_asset_id: 'stale-lib-asset',
        knauf_upload_finalized: true,
      }),
      true,
      { userId: 'user-123', tenantId: null },
    );
  });

  test('rejects finalization recovery when the asset belongs to another agent scope', async () => {
    const req = { ...libReq(), knaufRecoverAssetId: 'other-agent-asset' };
    db.getAssetByAssetId.mockResolvedValue({
      asset_id: 'other-agent-asset',
      status: 'ready',
      active_generation: 1,
      scope_type: 'agent',
      scope_id: 'agent-other',
      blob: { source: 'local', path: '/blob/other.pdf', bytes: 10, mime: PDF_MIME },
    });

    await expect(
      processAgentFileUpload({ req, res: mockRes, metadata: libMeta() }),
    ).rejects.toThrow('file_asset_finalization_scope_mismatch');

    expect(db.addAgentResourceFile).not.toHaveBeenCalled();
    expect(db.createFile).not.toHaveBeenCalled();
  });
});
// End [knauf]
