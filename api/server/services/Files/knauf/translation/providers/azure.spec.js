// [knauf] KK20-297 — Azure provider contracts for supported file translation.
'use strict';

const { createHash } = require('crypto');

const mockSourceBlob = {
  url: 'https://storage.example.test/translation-source/job/source.pdf',
  uploadData: jest.fn(),
  generateSasUrl: jest.fn(),
  deleteIfExists: jest.fn(),
};
const mockTargetBlob = {
  url: 'https://storage.example.test/translation-target/job/target.pdf',
  getProperties: jest.fn(),
  generateSasUrl: jest.fn(),
  downloadToBuffer: jest.fn(),
  deleteIfExists: jest.fn(),
};
const mockSourceContainer = {
  createIfNotExists: jest.fn(),
  getBlockBlobClient: jest.fn(),
};
const mockTargetContainer = {
  createIfNotExists: jest.fn(),
  generateSasUrl: jest.fn(),
  getBlockBlobClient: jest.fn(),
};
const mockGetContainerClient = jest.fn();

jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: {
    fromConnectionString: () => ({ getContainerClient: mockGetContainerClient }),
  },
  BlobSASPermissions: { parse: (value) => value },
  ContainerSASPermissions: { parse: (value) => value },
  SASProtocol: { Https: 'https' },
}));

const {
  glossaryForRequest,
  translateBatchWithAzure,
  translateDocumentWithAzure,
  translateWithAzure,
} = require('./azure');

const segments = [
  { id: 's0-c0', source: 'Hello' },
  { id: 's0-c1', source: 'High light reflectance (86%)' },
];
const glossary = {
  entries: [{ source: 'High light reflectance (86%)', target: 'Hoher Lichtreflexionsgrad (86 %)' }],
};

describe('[knauf] Azure translation provider', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
    };
    delete process.env.KNAUF_IDML_GLOSSARY_PATH;
    delete process.env.KNAUF_TRANSLATION_GLOSSARY_BLOB;
    delete process.env.KNAUF_TRANSLATION_GLOSSARY_REQUIRED;
    delete process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION;
    mockGetContainerClient.mockImplementation((name) =>
      name === 'translation-source' ? mockSourceContainer : mockTargetContainer,
    );
    mockSourceContainer.getBlockBlobClient.mockReturnValue(mockSourceBlob);
    mockTargetContainer.getBlockBlobClient.mockReturnValue(mockTargetBlob);
    mockSourceBlob.generateSasUrl.mockResolvedValue(
      'https://storage.example.test/translation-source/job/source.pdf?sig=source-secret',
    );
    mockTargetContainer.generateSasUrl.mockResolvedValue(
      'https://storage.example.test/translation-target?sig=target-container-secret',
    );
    mockTargetBlob.downloadToBuffer.mockResolvedValue(Buffer.from('%PDF translated'));
  });

  it('fails closed when the required Knauf glossary is not configured', async () => {
    process.env.KNAUF_TRANSLATION_GLOSSARY_REQUIRED = 'true';

    await expect(
      glossaryForRequest({ sourceLocale: 'en', targetLocale: 'de', segments }),
    ).rejects.toMatchObject({ code: 'glossary_not_found', status: 503 });
  });

  it('requires an explicit source locale when the Knauf glossary is enabled', async () => {
    process.env.KNAUF_TRANSLATION_GLOSSARY_BLOB = 'global-dictionary.csv';

    await expect(
      glossaryForRequest({ sourceLocale: null, targetLocale: 'de', segments }),
    ).rejects.toMatchObject({ code: 'source_locale_required', status: 400 });
  });

  it('caches an unchanged private glossary Blob by ETag', async () => {
    const csv = Buffer.from('id,a,b,c,eng_GLO,deu_GLO\n1,,,,Hello,Hallo\n');
    process.env.KNAUF_TRANSLATION_GLOSSARY_BLOB = 'global-dictionary.csv';
    process.env.AZURE_STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test-key';
    mockTargetBlob.getProperties.mockResolvedValue({ contentLength: csv.length, etag: 'v1' });
    mockTargetBlob.downloadToBuffer.mockResolvedValue(csv);

    const args = { sourceLocale: 'en', targetLocale: 'de', segments };
    await expect(glossaryForRequest(args)).resolves.toMatchObject({
      entries: [{ source: 'Hello', target: 'Hallo' }],
    });
    await glossaryForRequest(args);

    expect(mockTargetBlob.getProperties).toHaveBeenCalledTimes(2);
    expect(mockTargetBlob.downloadToBuffer).toHaveBeenCalledTimes(1);
  });

  it('rejects glossary content that does not match the pinned revision', async () => {
    const csv = Buffer.from('id,a,b,c,eng_GLO,deu_GLO\n1,,,,Hello,Hallo\n');
    process.env.KNAUF_TRANSLATION_GLOSSARY_BLOB = 'global-dictionary.csv';
    process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION = '0'.repeat(64);
    process.env.AZURE_STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test-key';
    mockTargetBlob.getProperties.mockResolvedValue({ contentLength: csv.length, etag: 'v2' });
    mockTargetBlob.downloadToBuffer.mockResolvedValue(csv);

    await expect(
      glossaryForRequest({ sourceLocale: 'en', targetLocale: 'de', segments }),
    ).rejects.toMatchObject({ code: 'glossary_revision_mismatch', status: 503 });
  });

  it('uses the complete language pair when document text is unavailable', async () => {
    const csv = Buffer.from('id,a,b,c,eng_GLO,deu_GLO\n1,,,,Hello,Hallo\n');
    process.env.KNAUF_TRANSLATION_GLOSSARY_BLOB = 'global-dictionary.csv';
    process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION = createHash('sha256')
      .update(csv)
      .digest('hex');
    process.env.AZURE_STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test-key';
    mockTargetBlob.getProperties.mockResolvedValue({ contentLength: csv.length, etag: 'v3' });
    mockTargetBlob.downloadToBuffer.mockResolvedValue(csv);

    await expect(
      glossaryForRequest({
        sourceLocale: 'en',
        targetLocale: 'de',
        segments: [],
        filterToDocument: false,
      }),
    ).resolves.toMatchObject({
      entries: [{ source: 'Hello', target: 'Hallo' }],
      stats: { filteredToDocument: false },
    });
  });

  it('fails instead of silently truncating applicable glossary terms', async () => {
    const csv = Buffer.from('id,a,b,c,eng_GLO,deu_GLO\n1,,,,Hello,Hallo\n');
    process.env.KNAUF_TRANSLATION_GLOSSARY_BLOB = 'global-dictionary.csv';
    process.env.AZURE_STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test-key';
    mockTargetBlob.getProperties.mockResolvedValue({ contentLength: csv.length, etag: 'v4' });
    mockTargetBlob.downloadToBuffer.mockResolvedValue(csv);

    await expect(
      glossaryForRequest({
        sourceLocale: 'en',
        targetLocale: 'de',
        segments,
        maxBytes: 1,
      }),
    ).rejects.toMatchObject({ code: 'glossary_too_large', status: 400 });
  });

  it('fails closed when a required glossary lacks the target locale', async () => {
    const csv = Buffer.from('id,a,b,c,eng_GLO,fra_GLO\n1,,,,Hello,Bonjour\n');
    process.env.KNAUF_TRANSLATION_GLOSSARY_BLOB = 'global-dictionary.csv';
    process.env.KNAUF_TRANSLATION_GLOSSARY_REQUIRED = 'true';
    process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION = createHash('sha256')
      .update(csv)
      .digest('hex');
    process.env.AZURE_STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test-key';
    mockTargetBlob.getProperties.mockResolvedValue({ contentLength: csv.length, etag: 'v5' });
    mockTargetBlob.downloadToBuffer.mockResolvedValue(csv);

    await expect(
      glossaryForRequest({ sourceLocale: 'en', targetLocale: 'de', segments }),
    ).rejects.toMatchObject({ code: 'glossary_locale_unsupported', status: 400 });
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it('round-trips stable IDs through Azure-generated XLIFF', async () => {
    process.env.AZURE_TRANSLATOR_ENDPOINT = 'https://translator.example.test';
    process.env.AZURE_TRANSLATOR_KEY = 'translator-key';
    const translatedXliff = Buffer.from(
      '<?xml version="1.0"?><xliff version="1.2"><file><body><trans-unit id="s0-c0"><source>Hello</source><target>Hallo</target></trans-unit><trans-unit id="s0-c1"><source>High light reflectance (86%)</source><target>Hoher Lichtreflexionsgrad (86 %)</target></trans-unit></body></file></xliff>',
    );
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ translation: { en: {}, de: {} } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => translatedXliff,
      });

    const result = await translateWithAzure({
      segments,
      sourceLocale: 'en',
      targetLocale: 'de-DE',
      glossary,
    });

    expect(result.providerLocale).toBe('de');
    expect(result.translations.get('s0-c0')).toBe('Hallo');
    const [request] = global.fetch.mock.calls.find(([url]) =>
      String(url).includes('/translator/document:translate?'),
    );
    const requestUrl = new URL(request);
    expect(requestUrl.pathname).toBe('/translator/document:translate');
    expect(Object.fromEntries(requestUrl.searchParams)).toMatchObject({
      targetLanguage: 'de',
      sourceLanguage: 'en',
      'api-version': '2026-03-01',
    });
    expect(global.fetch.mock.calls[1][1].body).toBeInstanceOf(FormData);
  });

  it('forwards an explicit non-English source locale', async () => {
    process.env.AZURE_TRANSLATOR_ENDPOINT = 'https://translator.example.test';
    process.env.AZURE_TRANSLATOR_KEY = 'translator-key';
    global.fetch = jest.fn((url) =>
      Promise.resolve(
        String(url).includes('/languages?')
          ? { ok: true, json: async () => ({ translation: { de: {}, en: {} } }) }
          : {
              ok: true,
              arrayBuffer: async () =>
                Buffer.from(
                  '<?xml version="1.0"?><xliff version="1.2"><file><body><trans-unit id="s0-c0"><source>Hallo</source><target>Hello</target></trans-unit></body></file></xliff>',
                ),
            },
      ),
    );

    const result = await translateWithAzure({
      segments: [{ id: 's0-c0', source: 'Hallo' }],
      sourceLocale: 'de-DE',
      targetLocale: 'en-US',
      glossary: { entries: [] },
    });

    expect(result.translations.get('s0-c0')).toBe('Hello');
    const [requestUrlValue] = global.fetch.mock.calls.find(([url]) =>
      String(url).includes('/translator/document:translate?'),
    );
    const requestUrl = new URL(requestUrlValue);
    expect(Object.fromEntries(requestUrl.searchParams)).toMatchObject({
      sourceLanguage: 'de',
      targetLanguage: 'en',
    });
  });

  it('requests text-within-image translation on the synchronous document path', async () => {
    process.env.AZURE_TRANSLATOR_ENDPOINT = 'https://translator.example.test';
    process.env.AZURE_TRANSLATOR_KEY = 'translator-key';
    global.fetch = jest.fn((url) =>
      Promise.resolve(
        String(url).includes('/languages?')
          ? { ok: true, json: async () => ({ translation: { en: {}, de: {} } }) }
          : { ok: true, arrayBuffer: async () => Buffer.from('translated docx') },
      ),
    );

    await translateDocumentWithAzure({
      buffer: Buffer.from('source docx'),
      filename: 'source.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sourceLocale: 'en',
      targetLocale: 'de',
      glossary: { entries: [] },
      translateTextWithinImage: true,
    });

    const [url] = global.fetch.mock.calls.find(([requestUrl]) =>
      String(requestUrl).includes('/translator/document:translate?'),
    );
    expect(String(url)).toContain('translateTextWithinImage=true');
  });

  it.each([
    [400, 'translator_rejected', 400],
    [401, 'translator_auth_failed', 401],
    [429, 'translator_rate_limited', 429],
    [503, 'translator_failed', 503],
  ])(
    'preserves Azure %i for durable retry classification',
    async (providerStatus, code, status) => {
      process.env.AZURE_TRANSLATOR_ENDPOINT = 'https://translator.example.test';
      process.env.AZURE_TRANSLATOR_KEY = 'translator-key';
      global.fetch = jest.fn((url) =>
        Promise.resolve(
          String(url).includes('/languages?')
            ? { ok: true, json: async () => ({ translation: { en: {}, de: {} } }) }
            : {
                ok: false,
                status: providerStatus,
                headers: new Headers({ 'retry-after': '3' }),
              },
        ),
      );

      await expect(
        translateDocumentWithAzure({
          buffer: Buffer.from('source'),
          filename: 'source.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sourceLocale: 'en',
          targetLocale: 'de',
          glossary: { entries: [] },
        }),
      ).rejects.toMatchObject({ code, status, retryAfter: '3' });
    },
  );

  it('runs batch translation through private scratch blobs and cleans them', async () => {
    process.env.AZURE_TRANSLATOR_ENDPOINT = 'https://translator.example.test';
    process.env.AZURE_TRANSLATOR_KEY = 'translator-key';
    process.env.AZURE_STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test-key';
    global.fetch = jest.fn((url, options) => {
      if (String(url).includes('/languages?')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ translation: { en: {}, de: {} } }),
        });
      }
      if (options?.method === 'POST') {
        return Promise.resolve({
          status: 202,
          headers: new Headers({
            'operation-location':
              'https://translator.example.test/translator/document/batches/job-1?api-version=2026-03-01',
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ status: 'Succeeded' }),
      });
    });

    const result = await translateBatchWithAzure({
      buffer: Buffer.from('%PDF source'),
      filename: 'source.pdf',
      mimeType: 'application/pdf',
      sourceLocale: 'en',
      targetLocale: 'de',
      glossary: { entries: [] },
      translateTextWithinImage: true,
    });

    const batchCall = global.fetch.mock.calls.find(([, options]) => options?.method === 'POST');
    const request = JSON.parse(batchCall[1].body);
    expect(request.inputs[0]).toMatchObject({
      storageType: 'File',
      source: { language: 'en' },
      targets: [
        {
          language: 'de',
          targetUrl:
            'https://storage.example.test/translation-target/job/target.pdf?sig=target-container-secret',
        },
      ],
    });
    expect(request.options).toEqual({ translateTextWithinImage: true });
    expect(mockSourceBlob.generateSasUrl).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: 'r' }),
    );
    expect(mockTargetBlob.generateSasUrl).not.toHaveBeenCalled();
    expect(mockTargetContainer.generateSasUrl).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: 'cwl' }),
    );
    expect(result.buffer.toString()).toBe('%PDF translated');
    expect(mockSourceBlob.uploadData).toHaveBeenCalled();
    expect(mockSourceBlob.deleteIfExists).toHaveBeenCalled();
    expect(mockTargetBlob.deleteIfExists).toHaveBeenCalled();
  });

  it('treats Azure batch validation failures as permanent rejections', async () => {
    process.env.AZURE_TRANSLATOR_ENDPOINT = 'https://translator.example.test';
    process.env.AZURE_TRANSLATOR_KEY = 'translator-key';
    process.env.AZURE_STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test-key';
    global.fetch = jest.fn((url, options) => {
      if (String(url).includes('/languages?')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ translation: { en: {}, de: {} } }),
        });
      }
      if (options?.method === 'POST') {
        return Promise.resolve({
          status: 202,
          headers: new Headers({
            'operation-location':
              'https://translator.example.test/translator/document/batches/job-invalid?api-version=2026-03-01',
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ status: 'ValidationFailed' }),
      });
    });

    await expect(
      translateBatchWithAzure({
        buffer: Buffer.from('%PDF source'),
        filename: 'source.pdf',
        mimeType: 'application/pdf',
        sourceLocale: 'en',
        targetLocale: 'de',
        glossary: { entries: [] },
      }),
    ).rejects.toMatchObject({ code: 'translator_rejected', status: 400 });
  });

  it('cancels an aborted batch before deleting its scratch blobs', async () => {
    process.env.AZURE_TRANSLATOR_ENDPOINT = 'https://translator.example.test';
    process.env.AZURE_TRANSLATOR_KEY = 'translator-key';
    process.env.AZURE_STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test-key';
    const controller = new AbortController();
    global.fetch = jest.fn((url, options) => {
      if (options?.method === 'POST') {
        controller.abort(new Error('request aborted'));
        return Promise.resolve({
          status: 202,
          headers: new Headers({
            'operation-location':
              'https://translator.example.test/translator/document/batches/job-2?api-version=2026-03-01',
          }),
        });
      }
      if (options?.method === 'DELETE') {
        return Promise.resolve({ status: 202 });
      }
      return Promise.resolve({ ok: true, json: async () => ({ status: 'Cancelled' }) });
    });

    await expect(
      translateBatchWithAzure({
        buffer: Buffer.from('%PDF source'),
        filename: 'source.pdf',
        mimeType: 'application/pdf',
        sourceLocale: 'en',
        targetLocale: 'de',
        glossary: { entries: [] },
        signal: controller.signal,
      }),
    ).rejects.toThrow('request aborted');

    const methods = global.fetch.mock.calls.map(([, options]) => options?.method ?? 'GET');
    expect(methods).toContain('DELETE');
    expect(methods.indexOf('DELETE')).toBeLessThan(methods.lastIndexOf('GET'));
    expect(mockSourceBlob.deleteIfExists).toHaveBeenCalled();
  });

  it('leaves scratch for lifecycle cleanup when batch acceptance is ambiguous', async () => {
    process.env.AZURE_TRANSLATOR_ENDPOINT = 'https://translator.example.test';
    process.env.AZURE_TRANSLATOR_KEY = 'translator-key';
    process.env.AZURE_STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test-key';
    global.fetch = jest.fn((url, options) => {
      if (String(url).includes('/languages?')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ translation: { en: {}, de: {} } }),
        });
      }
      if (options?.method === 'POST') {
        return Promise.reject(new Error('response lost after dispatch'));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(
      translateBatchWithAzure({
        buffer: Buffer.from('%PDF source'),
        filename: 'source.pdf',
        mimeType: 'application/pdf',
        sourceLocale: 'en',
        targetLocale: 'de',
        glossary: { entries: [] },
      }),
    ).rejects.toThrow('response lost after dispatch');

    expect(mockSourceBlob.deleteIfExists).not.toHaveBeenCalled();
    expect(mockTargetBlob.deleteIfExists).not.toHaveBeenCalled();
  });
});
// End [knauf]
