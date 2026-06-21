jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid') }));

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('@librechat/agents', () => ({
  EnvVar: { CODE_API_KEY: 'CODE_API_KEY' },
}));

jest.mock('@librechat/api', () => ({
  sanitizeFilename: jest.fn((n) => n),
  parseText: jest.fn().mockResolvedValue({ text: '', bytes: 0 }),
  processAudioFile: jest.fn(),
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  mergeFileConfig: jest.fn(),
}));

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
  updateFileUsage: jest.fn(),
  deleteFiles: jest.fn(),
  addAgentResourceFile: jest.fn().mockResolvedValue({}),
  removeAgentResourceFiles: jest.fn(),
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

jest.mock('~/server/utils', () => ({
  determineFileType: jest.fn(),
}));

jest.mock('~/server/services/Files/Audio/STTService', () => ({
  STTService: { getInstance: jest.fn() },
}));

const { EToolResources, FileSources, AgentCapabilities } = require('librechat-data-provider');
const { mergeFileConfig } = require('librechat-data-provider');
const { checkCapability } = require('~/server/services/Config');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { processAgentFileUpload, filterFile } = require('./process');

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLS_MIME = 'application/vnd.ms-excel';
const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';
const ODT_MIME = 'application/vnd.oasis.opendocument.text';
const ODP_MIME = 'application/vnd.oasis.opendocument.presentation';
const ODG_MIME = 'application/vnd.oasis.opendocument.graphics';

const makeReq = ({ mimetype = PDF_MIME, ocrConfig = null } = {}) => ({
  user: { id: 'user-123' },
  file: {
    path: '/tmp/upload.bin',
    originalname: 'upload.bin',
    filename: 'upload-uuid.bin',
    mimetype,
  },
  body: { model: 'gpt-4o' },
  config: {
    fileConfig: {},
    fileStrategy: 'local',
    ocr: ocrConfig,
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
