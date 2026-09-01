'use strict';

const mockUploadData = jest.fn().mockResolvedValue(undefined);
const mockBlockBlobClient = { url: 'https://storage.example/blob', uploadData: mockUploadData };
const mockContainerClient = {
  url: 'https://storage.example/container',
  exists: jest.fn().mockResolvedValue(true),
  createIfNotExists: jest.fn(),
  getBlockBlobClient: jest.fn(() => mockBlockBlobClient),
};

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));
jest.mock('~/server/controllers/agents/knauf/providerError', () => ({
  summarizeProviderError: jest.fn(() => ({})),
}));
jest.mock('@librechat/api', () => ({
  deleteRagFile: jest.fn(),
  getAzureContainerClient: jest.fn(() => mockContainerClient),
}));
jest.mock('@azure/identity', () => ({
  DefaultAzureCredential: jest.fn(),
  ManagedIdentityCredential: jest.fn(),
}));
jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: jest.fn(),
  BlobSASPermissions: { parse: jest.fn() },
  SASProtocol: { Https: 'https' },
  StorageSharedKeyCredential: jest.fn(),
  generateBlobSASQueryParameters: jest.fn(),
}));

describe('[knauf] Azure buffer upload', () => {
  beforeAll(() => {
    process.env.AZURE_STORAGE_PUBLIC_ACCESS = 'true';
  });

  afterAll(() => {
    delete process.env.AZURE_STORAGE_PUBLIC_ACCESS;
  });

  it('passes the caller abort signal to the Azure SDK upload', async () => {
    const { saveBufferToAzure } = require('./crud');
    const controller = new AbortController();

    await saveBufferToAzure({
      userId: 'user-1',
      buffer: Buffer.from('output'),
      fileName: 'output.idml',
      abortSignal: controller.signal,
    });

    expect(mockUploadData).toHaveBeenCalledWith(Buffer.from('output'), {
      abortSignal: controller.signal,
    });
  });
});
