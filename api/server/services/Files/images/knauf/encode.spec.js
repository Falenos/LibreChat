const { Readable } = require('node:stream');

const mockPrepareImagePayload = jest.fn();
const mockGetDownloadStream = jest.fn();
const mockDetermineFileType = jest.fn();
const mockDeleteFilesWithDedupAwareness = jest.fn();
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=',
  'base64',
);
const JPEG_BYTES = Buffer.from('ffd8ffe000104a46494600', 'hex');

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}));

jest.mock('~/server/services/Files/knauf/cascadeDeleteConvoFiles', () => ({
  deleteFilesWithDedupAwareness: (...args) => mockDeleteFilesWithDedupAwareness(...args),
}));

jest.mock('@librechat/api', () => ({
  logAxiosError: jest.fn(),
  validateImage: jest.fn(async () => ({ isValid: true })),
}));

jest.mock('~/server/utils/files', () => ({
  determineFileType: (...args) => mockDetermineFileType(...args),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({
    prepareImagePayload: (...args) => mockPrepareImagePayload(...args),
    getDownloadStream: (...args) => mockGetDownloadStream(...args),
  })),
}));

const {
  FileSources,
  VisionModes,
  EModelEndpoint,
  knaufCategorySizeLimits,
} = require('librechat-data-provider');
const { encodeAndFormat } = require('../encode');

const makeImage = (overrides = {}) => ({
  file_id: 'file-1',
  filepath: 'https://storage.example.test/image.png?sig=secret',
  filename: 'private-name.png',
  source: FileSources.azure_blob,
  type: 'image/png',
  bytes: PNG_BYTES.length,
  width: 10,
  height: 10,
  ...overrides,
});

const makeRequest = (fileConfig) => ({ body: {}, config: { fileConfig } });

describe('[knauf] image provider payload normalization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDetermineFileType.mockResolvedValue({ ext: 'png', mime: 'image/png' });
    mockPrepareImagePayload.mockImplementation(async (_req, file) => [file, file.filepath]);
    mockGetDownloadStream.mockResolvedValue(Readable.from(PNG_BYTES));
    mockDeleteFilesWithDedupAwareness.mockResolvedValue(undefined);
  });

  it('supplies private Azure blob bytes to Foundry without forwarding its signed URL', async () => {
    const image = makeImage();
    const result = await encodeAndFormat(
      makeRequest(),
      [image],
      { endpoint: EModelEndpoint.agents, provider: EModelEndpoint.azureOpenAI },
      VisionModes.agents,
    );

    expect(mockGetDownloadStream).toHaveBeenCalledWith(expect.any(Object), image.filepath);
    expect(result.image_urls[0].image_url.url).toBe(
      `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
    );
    expect(JSON.stringify(result.image_urls)).not.toContain('sig=secret');
  });

  it('still embeds Azure blob bytes after serverless Foundry normalizes the provider', async () => {
    const image = makeImage();
    const result = await encodeAndFormat(
      makeRequest(),
      [image],
      { endpoint: EModelEndpoint.agents, provider: EModelEndpoint.openAI },
      VisionModes.agents,
    );

    expect(mockGetDownloadStream).toHaveBeenCalledWith(expect.any(Object), image.filepath);
    expect(result.image_urls[0].image_url.url).toBe(
      `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
    );
    expect(mockPrepareImagePayload).not.toHaveBeenCalled();
  });

  it('still supplies base64 to providers that require inline image content', async () => {
    const result = await encodeAndFormat(
      makeRequest(),
      [makeImage()],
      { provider: EModelEndpoint.google },
      VisionModes.agents,
    );

    expect(mockGetDownloadStream).toHaveBeenCalledTimes(1);
    expect(result.image_urls[0].image_url.url).toBe(
      `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
    );
  });

  it('rejects a Blob that exceeds the configured limit despite safe Mongo metadata', async () => {
    mockGetDownloadStream.mockResolvedValue(Readable.from(Buffer.concat([PNG_BYTES, PNG_BYTES])));
    const fileConfig = { endpoints: { agents: { fileSizeLimit: 0.00002 } } };

    await expect(
      encodeAndFormat(
        makeRequest(fileConfig),
        [makeImage({ bytes: 10 })],
        { endpoint: EModelEndpoint.agents, provider: EModelEndpoint.azureOpenAI },
        VisionModes.agents,
      ),
    ).rejects.toThrow('Image normalization failed');
    expect(mockPrepareImagePayload).not.toHaveBeenCalled();
  });

  it('rejects Blob bytes whose media signature differs from Mongo metadata', async () => {
    mockGetDownloadStream.mockResolvedValue(Readable.from(JPEG_BYTES));
    mockDetermineFileType.mockResolvedValue({ ext: 'jpg', mime: 'image/jpeg' });

    await expect(
      encodeAndFormat(
        makeRequest(),
        [makeImage()],
        { endpoint: EModelEndpoint.agents, provider: EModelEndpoint.azureOpenAI },
        VisionModes.agents,
      ),
    ).rejects.toThrow('Image normalization failed');
    expect(mockPrepareImagePayload).not.toHaveBeenCalled();
  });

  it('reconciles a missing Azure attachment once and returns a stable public code', async () => {
    const image = makeImage();
    mockGetDownloadStream.mockRejectedValueOnce({ response: { status: 404 } });

    await expect(
      encodeAndFormat(
        makeRequest(),
        [image],
        { endpoint: EModelEndpoint.agents, provider: EModelEndpoint.azureOpenAI },
        VisionModes.agents,
      ),
    ).rejects.toMatchObject({ code: 'attachment_unavailable', message: 'attachment_unavailable' });

    expect(mockGetDownloadStream).toHaveBeenCalledTimes(1);
    expect(mockDeleteFilesWithDedupAwareness).toHaveBeenCalledTimes(1);
    expect(mockDeleteFilesWithDedupAwareness).toHaveBeenCalledWith({
      req: expect.any(Object),
      files: [image],
    });
    const { logger } = require('@librechat/data-schemas');
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Attachment unavailable', {
      operation: 'attachment_reconciliation',
      storageSource: FileSources.azure_blob,
      cleanup: 'completed',
    });
  });

  it('rejects unsupported stored image metadata before provider serialization', async () => {
    await expect(
      encodeAndFormat(
        makeRequest(),
        [makeImage({ type: 'application/x-msdownload' })],
        { endpoint: EModelEndpoint.agents },
        VisionModes.agents,
      ),
    ).rejects.toThrow('Unsupported image type');
    expect(mockPrepareImagePayload).not.toHaveBeenCalled();
  });

  it('rejects images above the Knauf image cap without disclosing the filename', async () => {
    await expect(
      encodeAndFormat(
        makeRequest(),
        [makeImage({ bytes: knaufCategorySizeLimits.image + 1 })],
        { endpoint: EModelEndpoint.agents },
        VisionModes.agents,
      ),
    ).rejects.toThrow('Invalid image size');
    expect(mockPrepareImagePayload).not.toHaveBeenCalled();
  });
});
