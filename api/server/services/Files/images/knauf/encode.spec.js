const { Readable } = require('node:stream');

const mockPrepareImagePayload = jest.fn();
const mockGetDownloadStream = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  logAxiosError: jest.fn(),
  validateImage: jest.fn(async () => ({ isValid: true })),
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
  bytes: 1024,
  width: 10,
  height: 10,
  ...overrides,
});

const makeRequest = () => ({ body: {}, config: {} });

describe('[knauf] image provider payload normalization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepareImagePayload.mockImplementation(async (_req, file) => [file, file.filepath]);
    mockGetDownloadStream.mockResolvedValue(Readable.from(Buffer.from('image-bytes')));
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
      `data:image/png;base64,${Buffer.from('image-bytes').toString('base64')}`,
    );
    expect(JSON.stringify(result.image_urls)).not.toContain('sig=secret');
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
      `data:image/png;base64,${Buffer.from('image-bytes').toString('base64')}`,
    );
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
