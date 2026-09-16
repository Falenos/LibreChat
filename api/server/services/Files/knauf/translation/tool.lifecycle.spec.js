// [knauf] KK20-297 — output rollback and per-file failure semantics.
'use strict';

const { Readable } = require('stream');
const JSZip = require('jszip');
const { IdmlError } = require('../idml/core');

const mockSaveBuffer = jest.fn();
const mockDeleteFile = jest.fn();
const mockGetDownloadStream = jest.fn();
const mockGetFiles = jest.fn();
const mockCreateFile = jest.fn();
const mockTranslateDocumentWithAzure = jest.fn();
const mockTranslateBatchWithAzure = jest.fn();
const mockTranslateWithAzure = jest.fn();
const mockGlossaryForRequest = jest.fn();
const mockMergePreservedTerms = jest.fn();
const mockGetOwnedTranslationJob = jest.fn();
const mockRequestTranslationCancellation = jest.fn();
const mockRecordFileTranslationOutcome = jest.fn();
const mockGetCloudFrontConfig = jest.fn();
const mockGetRetentionExpiry = jest.fn();
const mockDetectProtectedLogo = jest.fn();
const mockMaskRegionForTranslation = jest.fn();
const mockRestoreProtectedRegion = jest.fn();

jest.mock('../../strategies', () => ({
  getStrategyFunctions: () => ({
    saveBuffer: mockSaveBuffer,
    deleteFile: mockDeleteFile,
    getDownloadStream: mockGetDownloadStream,
  }),
}));
jest.mock('./providers/azure', () => ({
  AZURE_BATCH_GLOSSARY_MAX_BYTES: 9 * 1024 * 1024,
  AZURE_SYNC_GLOSSARY_MAX_BYTES: 900 * 1024,
  glossaryForRequest: (...args) => mockGlossaryForRequest(...args),
  mergePreservedTerms: (...args) => mockMergePreservedTerms(...args),
  translateBatchWithAzure: (...args) => mockTranslateBatchWithAzure(...args),
  translateDocumentWithAzure: (...args) => mockTranslateDocumentWithAzure(...args),
  translateWithAzure: (...args) => mockTranslateWithAzure(...args),
}));
jest.mock('./jobs', () => ({
  ...jest.requireActual('./jobs'),
  getOwnedTranslationJob: (...args) => mockGetOwnedTranslationJob(...args),
  requestTranslationCancellation: (...args) => mockRequestTranslationCancellation(...args),
}));
jest.mock('../../retention', () => ({
  getRetentionExpiry: (...args) => mockGetRetentionExpiry(...args),
}));
jest.mock('./logoProtection', () => ({
  ...jest.requireActual('./logoProtection'),
  detectProtectedLogo: (...args) => mockDetectProtectedLogo(...args),
  maskRegionForTranslation: (...args) => mockMaskRegionForTranslation(...args),
  restoreProtectedRegion: (...args) => mockRestoreProtectedRegion(...args),
}));
jest.mock('~/models', () => ({
  getFiles: (...args) => mockGetFiles(...args),
  createFile: (...args) => mockCreateFile(...args),
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  getCloudFrontConfig: () => mockGetCloudFrontConfig(),
  getStorageMetadata: () => ({}),
  recordFileTranslationOutcome: (...args) => mockRecordFileTranslationOutcome(...args),
}));

const {
  persistOutput,
  normalizePreserveTerms,
  resolveInputFileResults,
  resolveInputFiles,
  selectTranslationFiles,
  translateFiles,
  translationJobAction,
} = require('./tool');

const request = (files = []) => ({
  user: { id: 'user-1', tenantId: 'tenant-1' },
  body: { files, conversationId: 'conversation-1' },
  config: { fileStrategy: 'local' },
});

async function idmlFixture(
  story = '<ParagraphStyleRange><CharacterStyleRange><Content>HERADESIGN panel</Content></CharacterStyleRange></ParagraphStyleRange>',
) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.adobe.indesign-idml-package', {
    compression: 'STORE',
    createFolders: false,
  });
  zip.file(
    'designmap.xml',
    '<?xml version="1.0"?><Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><idPkg:Story src="Stories/Story_u1.xml"/></Document>',
  );
  zip.file(
    'Stories/Story_u1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><Story Self="u1">${story}</Story></idPkg:Story>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('[knauf] file translation lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveBuffer.mockResolvedValue('/uploads/user-1/output.docx');
    mockDeleteFile.mockResolvedValue(undefined);
    mockGetDownloadStream.mockImplementation(() => Readable.from([Buffer.from('source')]));
    mockCreateFile.mockImplementation(async (metadata) => metadata);
    mockGetFiles.mockResolvedValue([]);
    mockGetCloudFrontConfig.mockReturnValue(null);
    mockGlossaryForRequest.mockResolvedValue({
      entries: [],
      stats: { configured: false, applied: 0, bytes: 0 },
    });
    mockMergePreservedTerms.mockImplementation((glossary) => glossary);
    mockGetRetentionExpiry.mockResolvedValue({});
    mockDetectProtectedLogo.mockResolvedValue([]);
    mockMaskRegionForTranslation.mockResolvedValue(Buffer.from('masked'));
    mockRestoreProtectedRegion.mockImplementation(async (buffer) => buffer);
    process.env.KNAUF_TRANSLATION_FILE_CONCURRENCY = '1';
    delete process.env.KNAUF_TRANSLATION_STORAGE_WRITE_TIMEOUT_MS;
  });

  it('deletes the saved blob when file metadata cannot be committed', async () => {
    mockCreateFile.mockRejectedValue(new Error('database unavailable'));
    const req = request();

    await expect(
      persistOutput({
        req,
        buffer: Buffer.from('translated'),
        filename: 'output.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        conversationId: 'conversation-1',
      }),
    ).rejects.toMatchObject({ code: 'storage_write_failed' });

    expect(mockDeleteFile).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ filepath: '/uploads/user-1/output.docx' }),
    );
  });

  it('keeps an output when a failed metadata acknowledgement actually committed', async () => {
    const persisted = {
      file_id: 'planned-output-1',
      filepath: '/uploads/user-1/output.docx',
      filename: 'output.docx',
    };
    mockCreateFile.mockRejectedValue(new Error('acknowledgement lost'));
    mockGetFiles.mockResolvedValue([persisted]);

    await expect(
      persistOutput({
        req: request(),
        buffer: Buffer.from('translated'),
        filename: 'output.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        conversationId: 'conversation-1',
        fileId: 'planned-output-1',
      }),
    ).resolves.toEqual(persisted);

    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('uses the durable job retention decision when persisting worker output', async () => {
    const expiredAt = new Date(Date.now() + 60_000);
    const req = request();
    req.knaufTranslationOutputExpiresAt = expiredAt;

    await persistOutput({
      req,
      buffer: Buffer.from('translated'),
      filename: 'output.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      conversationId: 'conversation-1',
    });

    expect(mockCreateFile).toHaveBeenCalledWith(
      expect.objectContaining({ expiredAt }),
      true,
      expect.any(Object),
    );
    expect(mockGetRetentionExpiry).not.toHaveBeenCalled();
  });

  it('keeps an output when metadata reconciliation is unavailable', async () => {
    mockCreateFile.mockRejectedValue(new Error('acknowledgement lost'));
    mockGetFiles.mockRejectedValue(new Error('database unavailable'));

    await expect(
      persistOutput({
        req: request(),
        buffer: Buffer.from('translated'),
        filename: 'output.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        conversationId: 'conversation-1',
        fileId: 'planned-output-1',
      }),
    ).rejects.toMatchObject({ code: 'storage_write_failed' });

    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('uses the output id supplied by the claimed generation', async () => {
    const req = request();
    req.knaufTranslationPrepareStorageLocator = jest.fn().mockResolvedValue(true);

    await persistOutput({
      req,
      buffer: Buffer.from('translated'),
      filename: 'output.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      conversationId: 'conversation-1',
      fileId: 'planned-output-1',
    });

    expect(mockSaveBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'planned-output-1__output.docx' }),
    );
    expect(mockCreateFile).toHaveBeenCalledWith(
      expect.objectContaining({ file_id: 'planned-output-1' }),
      true,
      { userId: 'user-1', tenantId: 'tenant-1' },
    );
    expect(req.knaufTranslationPrepareStorageLocator).toHaveBeenCalledWith(
      expect.objectContaining({
        file_id: 'planned-output-1',
        source: 'local',
        filepath: '/uploads/user-1/planned-output-1__output.docx',
      }),
    );
    expect(req.knaufTranslationPrepareStorageLocator.mock.invocationCallOrder[0]).toBeLessThan(
      mockSaveBuffer.mock.invocationCallOrder[0],
    );
  });

  it('does not write a blob when its durable storage locator cannot be prepared', async () => {
    const req = request();
    req.knaufTranslationPrepareStorageLocator = jest.fn().mockResolvedValue(false);

    await expect(
      persistOutput({
        req,
        buffer: Buffer.from('translated'),
        filename: 'output.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        conversationId: 'conversation-1',
        fileId: 'planned-output-1',
      }),
    ).rejects.toMatchObject({ code: 'translation_fence_lost' });

    expect(mockSaveBuffer).not.toHaveBeenCalled();
  });

  it('prepares the exact region-prefixed CloudFront key before writing', async () => {
    const req = request();
    req.config.fileStrategy = 'cloudfront';
    mockGetCloudFrontConfig.mockReturnValue({
      includeRegionInPath: true,
      storageRegion: 'eu-central-1',
    });
    req.knaufTranslationPrepareStorageLocator = jest.fn().mockResolvedValue(true);

    await persistOutput({
      req,
      buffer: Buffer.from('translated'),
      filename: 'output.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      conversationId: 'conversation-1',
      fileId: 'planned-output-1',
    });

    expect(req.knaufTranslationPrepareStorageLocator).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: 'r/eu-central-1/t/tenant-1/uploads/user-1/planned-output-1__output.docx',
      }),
    );
  });

  it('does not publish metadata when cancellation wins during persist', async () => {
    const req = request();
    let fences = 0;
    req.knaufTranslationWriteFence = jest.fn(async () => {
      fences += 1;
      if (fences === 3) {
        throw Object.assign(new Error('cancelled during metadata persist'), {
          code: 'translation_fence_lost',
        });
      }
    });

    await expect(
      persistOutput({
        req,
        buffer: Buffer.from('translated'),
        filename: 'output.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        conversationId: 'conversation-1',
        fileId: 'generation-1-output',
      }),
    ).rejects.toMatchObject({
      code: 'translation_fence_lost',
      outputFiles: [expect.objectContaining({ file_id: 'generation-1-output' })],
    });

    expect(mockCreateFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('reaps a generation-specific blob that resolves after the write timeout', async () => {
    process.env.KNAUF_TRANSLATION_STORAGE_WRITE_TIMEOUT_MS = '1';
    const req = request();
    req.config.fileStrategy = 'cloudfront';
    mockGetCloudFrontConfig.mockReturnValue({
      includeRegionInPath: true,
      storageRegion: 'eu-central-1',
    });
    let finishWrite;
    mockSaveBuffer.mockReturnValueOnce(
      new Promise((resolve) => {
        finishWrite = resolve;
      }),
    );
    const pending = persistOutput({
      req,
      buffer: Buffer.from('translated'),
      filename: 'output.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      conversationId: 'conversation-1',
      fileId: 'generation-1-late-output',
    });

    await expect(pending).rejects.toMatchObject({ code: 'storage_write_timeout' });
    finishWrite(
      'https://cdn.example/r/eu-central-1/t/tenant-1/uploads/user-1/generation-1-late-output__output.docx',
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockDeleteFile).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        file_id: 'generation-1-late-output',
        user: 'user-1',
        tenantId: 'tenant-1',
        storageKey:
          'r/eu-central-1/t/tenant-1/uploads/user-1/generation-1-late-output__output.docx',
      }),
    );
    expect(mockCreateFile).not.toHaveBeenCalled();
  });

  it('resolves missing attachments as per-file failures', async () => {
    mockGetFiles.mockResolvedValue([
      { file_id: 'file-1', filename: 'one.docx', type: 'application/octet-stream' },
    ]);
    const results = await resolveInputFileResults(
      request([
        { file_id: 'file-1', filename: 'one.docx' },
        { file_id: 'file-2', filename: 'two.docx' },
      ]),
    );

    expect(results).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({
        status: 'rejected',
        filename: 'two.docx',
        reason: expect.objectContaining({ code: 'file_not_found' }),
      }),
    ]);
  });

  it('deduplicates repeated attachment IDs before translation', async () => {
    mockGetFiles.mockResolvedValue([
      { file_id: 'file-1', filename: 'one.docx', type: 'application/octet-stream' },
    ]);

    const results = await resolveInputFileResults(
      request([
        { file_id: 'file-1', filename: 'one.docx' },
        { file_id: 'file-1', filename: 'one.docx' },
      ]),
    );

    expect(results).toHaveLength(1);
  });

  it('resolves tool-only historical attachments without adding them to the message body', async () => {
    const file = { file_id: 'file-1', filename: 'one.docx', type: 'application/octet-stream' };
    mockGetFiles.mockResolvedValue([file]);
    const req = request();
    req.knaufToolFiles = [file];

    await expect(resolveInputFiles(req)).resolves.toEqual([file]);
    expect(req.body.files).toEqual([]);
  });

  it('requires explicit translation scope when multiple files are available', () => {
    const files = [{ filename: 'one.docx' }, { filename: 'two.docx' }];

    expect(() => selectTranslationFiles(files, {})).toThrow(
      expect.objectContaining({ code: 'translation_file_selection_required', status: 409 }),
    );
    expect(selectTranslationFiles(files, { filenames: ['two.docx'] })).toEqual([files[1]]);
    expect(selectTranslationFiles(files, { all_files: true })).toEqual(files);
  });

  it('rejects invalid, missing, and ambiguous translation selections', () => {
    const files = [{ filename: 'same.docx' }, { filename: 'same.docx' }];

    expect(() =>
      selectTranslationFiles(files, { filenames: ['same.docx'], all_files: true }),
    ).toThrow(expect.objectContaining({ code: 'invalid_translation_file_selection' }));
    expect(() => selectTranslationFiles(files, { filenames: ['missing.docx'] })).toThrow(
      expect.objectContaining({ code: 'translation_file_not_found' }),
    );
    expect(() => selectTranslationFiles(files, { filenames: ['same.docx'] })).toThrow(
      expect.objectContaining({ code: 'translation_file_ambiguous' }),
    );
  });

  it('normalizes and bounds exact terms that must remain untranslated', () => {
    expect(
      normalizePreserveTerms([
        ' Knauf Ceiling Solutions ',
        'HERADESIGN',
        'knauf ceiling solutions',
      ]),
    ).toEqual(['HERADESIGN', 'Knauf Ceiling Solutions', 'knauf ceiling solutions']);
    expect(() => normalizePreserveTerms(['line\nbreak'])).toThrow(
      expect.objectContaining({ code: 'invalid_preserve_terms', status: 400 }),
    );
    expect(() => normalizePreserveTerms(Array.from({ length: 101 }, () => 'term'))).toThrow(
      expect.objectContaining({ code: 'invalid_preserve_terms', status: 400 }),
    );
  });

  it('returns a complete failed report when every attachment is unavailable', async () => {
    mockGetFiles.mockResolvedValue([]);
    const result = await translateFiles({
      req: request([
        { file_id: 'file-1', filename: 'one.docx' },
        { file_id: 'file-2', filename: 'two.docx' },
      ]),
      args: { source_locale: 'en', target_locale: 'de' },
    });

    expect(result.files).toEqual([]);
    expect(result.report).toMatchObject({
      status: 'failed',
      files: [
        { sourceFile: 'one.docx', status: 'failed', code: 'file_not_found' },
        { sourceFile: 'two.docx', status: 'failed', code: 'file_not_found' },
      ],
    });
  });

  it('rolls successful sibling outputs into a retryable multi-file failure', async () => {
    const files = [
      {
        file_id: 'file-1',
        filename: 'one.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        source: 'local',
        filepath: '/uploads/one.docx',
      },
      {
        file_id: 'file-2',
        filename: 'two.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        source: 'local',
        filepath: '/uploads/two.docx',
      },
    ];
    mockGetFiles.mockResolvedValue(files);
    mockTranslateDocumentWithAzure
      .mockResolvedValueOnce({
        buffer: Buffer.from('translated'),
        providerLocale: 'de',
        batches: 1,
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('rate limited'), {
          code: 'translator_rate_limited',
          status: 429,
        }),
      );

    await expect(
      translateFiles({
        req: request(files),
        args: { source_locale: 'en', target_locale: 'de' },
      }),
    ).rejects.toMatchObject({
      code: 'translator_rate_limited',
      status: 429,
      outputFiles: [expect.objectContaining({ filename: 'one_de.docx' })],
    });
  });

  it('uses the batch path when an unfiltered native-document glossary exceeds sync limits', async () => {
    const file = {
      file_id: 'file-1',
      filename: 'one.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      source: 'local',
      filepath: '/uploads/one.docx',
    };
    mockGetFiles.mockResolvedValue([file]);
    mockGlossaryForRequest.mockResolvedValueOnce({
      entries: [{ source: 'Hello', target: 'Hallo' }],
      stats: { configured: true, applied: 1, bytes: 1024 * 1024 },
    });
    mockTranslateBatchWithAzure.mockResolvedValue({
      buffer: Buffer.from('translated'),
      providerLocale: 'de',
      batches: 1,
    });

    await expect(
      translateFiles({
        req: request([file]),
        args: { source_locale: 'en', target_locale: 'de' },
      }),
    ).resolves.toMatchObject({ report: { status: 'completed' } });

    expect(mockTranslateBatchWithAzure).toHaveBeenCalledTimes(1);
    expect(mockTranslateDocumentWithAzure).not.toHaveBeenCalled();
  });

  it('retries logo masking at a lower quality when the default-quality mask exceeds the Azure batch limit', async () => {
    const file = {
      file_id: 'file-1',
      filename: 'letterhead.png',
      type: 'image/png',
      source: 'local',
      filepath: '/uploads/letterhead.png',
    };
    const input = Buffer.from('source-image');
    mockGetFiles.mockResolvedValue([file]);
    mockGetDownloadStream.mockImplementation(() => Readable.from([input]));
    mockDetectProtectedLogo.mockResolvedValue([
      { name: 'knauf-wordmark', confidence: 0.95, x: 0, y: 0, width: 10, height: 10 },
    ]);
    const oversizedMask = Buffer.alloc(6 * 1024 * 1024, 1); // over the 5 MB image batch limit
    const acceptableMask = Buffer.alloc(2 * 1024 * 1024, 2); // within the limit at reduced quality
    mockMaskRegionForTranslation.mockImplementation(async (_buffer, _regions, options) =>
      options?.quality === 80 ? acceptableMask : oversizedMask,
    );
    mockTranslateBatchWithAzure.mockResolvedValue({
      buffer: Buffer.from('translated'),
      providerLocale: 'de',
      batches: 1,
    });

    await expect(
      translateFiles({
        req: request([file]),
        args: { source_locale: 'en', target_locale: 'de' },
      }),
    ).resolves.toMatchObject({ report: { status: 'completed' } });

    expect(mockMaskRegionForTranslation).toHaveBeenCalledTimes(2);
    expect(mockMaskRegionForTranslation).toHaveBeenNthCalledWith(1, input, expect.any(Array));
    expect(mockMaskRegionForTranslation).toHaveBeenNthCalledWith(
      2,
      input,
      expect.any(Array),
      expect.objectContaining({ quality: 80 }),
    );
    // The retried (still-masked) buffer must reach Azure, not the raw input.
    expect(mockTranslateBatchWithAzure).toHaveBeenCalledWith(
      expect.objectContaining({ buffer: acceptableMask }),
    );
    expect(mockRestoreProtectedRegion).toHaveBeenCalled();
  });

  it('gives up on logo protection when the mask still exceeds the Azure batch limit at reduced quality', async () => {
    const file = {
      file_id: 'file-1',
      filename: 'letterhead.png',
      type: 'image/png',
      source: 'local',
      filepath: '/uploads/letterhead.png',
    };
    const input = Buffer.from('source-image');
    mockGetFiles.mockResolvedValue([file]);
    mockGetDownloadStream.mockImplementation(() => Readable.from([input]));
    mockDetectProtectedLogo.mockResolvedValue([
      { name: 'knauf-wordmark', confidence: 0.95, x: 0, y: 0, width: 10, height: 10 },
    ]);
    const oversizedMask = Buffer.alloc(6 * 1024 * 1024, 1);
    mockMaskRegionForTranslation.mockResolvedValue(oversizedMask);
    mockTranslateBatchWithAzure.mockResolvedValue({
      buffer: Buffer.from('translated'),
      providerLocale: 'de',
      batches: 1,
    });

    await expect(
      translateFiles({
        req: request([file]),
        args: { source_locale: 'en', target_locale: 'de' },
      }),
    ).resolves.toMatchObject({ report: { status: 'completed' } });

    expect(mockMaskRegionForTranslation).toHaveBeenCalledTimes(2);
    // Both attempts exceeded the limit, so the unmasked original input is
    // translated instead of shipping an over-limit buffer or crashing.
    expect(mockTranslateBatchWithAzure).toHaveBeenCalledWith(
      expect.objectContaining({ buffer: input }),
    );
    // Nothing was masked, so there is nothing to restore afterwards.
    expect(mockRestoreProtectedRegion).not.toHaveBeenCalled();
  });

  it('merges explicit preserved terms before translating a native document', async () => {
    const file = {
      file_id: 'file-1',
      filename: 'one.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      source: 'local',
      filepath: '/uploads/one.docx',
    };
    mockGetFiles.mockResolvedValue([file]);
    mockMergePreservedTerms.mockReturnValueOnce({
      entries: [{ source: 'HERADESIGN', target: 'HERADESIGN' }],
      stats: { configured: false, applied: 1, preservedApplied: 1, bytes: 24 },
    });
    mockTranslateDocumentWithAzure.mockResolvedValue({
      buffer: Buffer.from('translated'),
      providerLocale: 'de',
      batches: 1,
    });

    await translateFiles({
      req: request([file]),
      args: {
        source_locale: 'en',
        target_locale: 'de',
        preserve_terms: ['HERADESIGN'],
      },
    });

    expect(mockMergePreservedTerms).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [] }),
      ['HERADESIGN'],
      [],
      expect.objectContaining({ filterToDocument: false }),
    );
    expect(mockTranslateDocumentWithAzure).toHaveBeenCalledWith(
      expect.objectContaining({
        glossary: expect.objectContaining({
          entries: [{ source: 'HERADESIGN', target: 'HERADESIGN' }],
        }),
      }),
    );
  });

  it('passes exact protected terms through the IDML segmented translation path', async () => {
    const file = {
      file_id: 'file-1',
      filename: 'brochure.idml',
      type: 'application/vnd.adobe.indesign-idml-package',
      source: 'local',
      filepath: '/uploads/brochure.idml',
    };
    mockGetFiles.mockResolvedValue([file]);
    mockGetDownloadStream.mockReturnValueOnce(Readable.from([await idmlFixture()]));
    mockMergePreservedTerms.mockImplementationOnce((glossary) => ({
      ...glossary,
      entries: [{ source: 'HERADESIGN', target: 'HERADESIGN' }],
      stats: {
        ...glossary.stats,
        configured: true,
        preservedApplied: 1,
        bytes: 24,
      },
    }));
    mockTranslateWithAzure.mockImplementationOnce(async ({ segments }) => ({
      translations: new Map(segments.map((segment) => [segment.id, segment.source])),
      providerLocale: 'pl',
      batches: 1,
    }));

    await expect(
      translateFiles({
        req: request([file]),
        args: {
          source_locale: 'en',
          target_locale: 'pl-PL',
          preserve_terms: ['HERADESIGN'],
        },
      }),
    ).resolves.toMatchObject({
      report: {
        status: 'completed',
        files: [{ glossary: { preservedApplied: 1 }, fontValidation: 'preserved' }],
      },
    });

    expect(mockMergePreservedTerms).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [] }),
      ['HERADESIGN'],
      expect.arrayContaining([expect.objectContaining({ source: 'HERADESIGN panel' })]),
    );
    expect(mockTranslateWithAzure).toHaveBeenCalledWith(
      expect.objectContaining({
        glossary: expect.objectContaining({
          entries: [{ source: 'HERADESIGN', target: 'HERADESIGN' }],
        }),
      }),
    );
  });

  it('does not translate or persist IDML when protected terms cross segment boundaries', async () => {
    const file = {
      file_id: 'file-1',
      filename: 'brochure.idml',
      type: 'application/vnd.adobe.indesign-idml-package',
      source: 'local',
      filepath: '/uploads/brochure.idml',
    };
    mockGetFiles.mockResolvedValue([file]);
    mockGetDownloadStream.mockReturnValueOnce(
      Readable.from([
        await idmlFixture(
          '<ParagraphStyleRange><CharacterStyleRange><Content>HERA</Content></CharacterStyleRange><CharacterStyleRange><Content>DESIGN</Content></CharacterStyleRange></ParagraphStyleRange>',
        ),
      ]),
    );
    mockMergePreservedTerms.mockImplementationOnce((_glossary, _terms, segments) => {
      expect(segments).toEqual([
        expect.objectContaining({ source: 'HERA', contentIndex: 0, partCount: 1 }),
        expect.objectContaining({ source: 'DESIGN', contentIndex: 1, partCount: 1 }),
      ]);
      const error = new IdmlError(
        'A protected term spans multiple IDML text segments and cannot be preserved safely',
        'protected_term_spans_segments',
        400,
      );
      error.protectedTermsRequired = true;
      throw error;
    });

    await expect(
      translateFiles({
        req: request([file]),
        args: {
          source_locale: 'en',
          target_locale: 'pl-PL',
          preserve_terms: ['HERADESIGN'],
        },
      }),
    ).resolves.toMatchObject({
      report: {
        status: 'failed',
        files: [
          {
            code: 'protected_term_spans_segments',
            protectedTermsRequired: true,
          },
        ],
      },
    });

    expect(mockTranslateWithAzure).not.toHaveBeenCalled();
    expect(mockSaveBuffer).not.toHaveBeenCalled();
    expect(mockCreateFile).not.toHaveBeenCalled();
  });

  it('does not restart segmented translation after a later batch was accepted', async () => {
    const file = {
      file_id: 'file-1',
      filename: 'brochure.idml',
      type: 'application/vnd.adobe.indesign-idml-package',
      source: 'local',
      filepath: '/uploads/brochure.idml',
    };
    mockGetFiles.mockResolvedValue([file]);
    mockGetDownloadStream.mockReturnValueOnce(Readable.from([await idmlFixture()]));
    mockGlossaryForRequest.mockResolvedValueOnce({
      entries: [{ source: 'panel', target: 'Panel' }],
      stats: { configured: true, applied: 1, bytes: 12 },
    });
    const error = new IdmlError('provider rejected a later batch', 'translator_rejected', 400);
    error.translationBatchesCompleted = 1;
    mockTranslateWithAzure.mockRejectedValueOnce(error);

    await expect(
      translateFiles({
        req: request([file]),
        args: { source_locale: 'en', target_locale: 'de' },
      }),
    ).resolves.toMatchObject({
      report: {
        status: 'failed',
        files: [{ code: 'translator_rejected' }],
      },
    });

    expect(mockTranslateWithAzure).toHaveBeenCalledTimes(1);
  });

  it('retries native document translation without an optional provider-rejected glossary', async () => {
    const file = {
      file_id: 'file-1',
      filename: 'one.pptx',
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      source: 'local',
      filepath: '/uploads/one.pptx',
    };
    mockGetFiles.mockResolvedValue([file]);
    mockGlossaryForRequest.mockResolvedValueOnce({
      entries: [{ source: 'Hello', target: 'Hallo' }],
      stats: { configured: true, applied: 1, bytes: 12 },
    });
    mockTranslateDocumentWithAzure
      .mockRejectedValueOnce(
        Object.assign(new Error('provider rejected glossary'), { code: 'translator_rejected' }),
      )
      .mockResolvedValueOnce({
        buffer: Buffer.from('translated'),
        providerLocale: 'de',
        batches: 1,
      });

    await expect(
      translateFiles({
        req: request([file]),
        args: { source_locale: 'en', target_locale: 'de' },
      }),
    ).resolves.toMatchObject({
      report: {
        status: 'completed',
        files: [
          {
            glossary: { applied: 0, requested: 1, reason: 'provider_rejected' },
          },
        ],
      },
    });

    expect(mockTranslateDocumentWithAzure).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ glossary: expect.objectContaining({ entries: [] }) }),
    );
  });

  it('retains explicit protected terms when the optional managed glossary is rejected', async () => {
    const file = {
      file_id: 'file-1',
      filename: 'one.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      source: 'local',
      filepath: '/uploads/one.docx',
    };
    mockGetFiles.mockResolvedValue([file]);
    mockGlossaryForRequest.mockResolvedValueOnce({
      entries: [{ source: 'Board', target: 'Platte' }],
      stats: { configured: true, applied: 1, bytes: 13 },
    });
    mockMergePreservedTerms
      .mockReturnValueOnce({
        entries: [
          { source: 'HERADESIGN', target: 'HERADESIGN' },
          { source: 'Board', target: 'Platte' },
        ],
        stats: {
          configured: true,
          dictionaryConfigured: true,
          dictionaryApplied: 1,
          applied: 2,
          preservedApplied: 1,
          bytes: 37,
        },
      })
      .mockReturnValueOnce({
        entries: [{ source: 'HERADESIGN', target: 'HERADESIGN' }],
        stats: {
          configured: true,
          dictionaryConfigured: true,
          dictionaryApplied: 1,
          dictionaryRetained: 0,
          applied: 1,
          preservedApplied: 1,
          bytes: 24,
        },
      });
    mockTranslateDocumentWithAzure
      .mockRejectedValueOnce(
        Object.assign(new Error('provider rejected glossary'), { code: 'translator_rejected' }),
      )
      .mockResolvedValueOnce({
        buffer: Buffer.from('translated'),
        providerLocale: 'de',
        batches: 1,
      });

    await expect(
      translateFiles({
        req: request([file]),
        args: {
          source_locale: 'en',
          target_locale: 'de',
          preserve_terms: ['HERADESIGN'],
        },
      }),
    ).resolves.toMatchObject({
      report: {
        files: [
          {
            glossary: {
              applied: 1,
              dictionaryApplied: 0,
              dictionaryRequested: 1,
              preservedApplied: 1,
              reason: 'dictionary_provider_rejected',
            },
          },
        ],
      },
    });

    expect(mockTranslateDocumentWithAzure).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        glossary: expect.objectContaining({
          entries: [{ source: 'HERADESIGN', target: 'HERADESIGN' }],
        }),
      }),
    );
  });

  it('fails without hiding the provider cause when protected terms were required', async () => {
    const file = {
      file_id: 'file-1',
      filename: 'one.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      source: 'local',
      filepath: '/uploads/one.docx',
    };
    mockGetFiles.mockResolvedValue([file]);
    mockMergePreservedTerms.mockReturnValueOnce({
      entries: [{ source: 'HERADESIGN', target: 'HERADESIGN' }],
      stats: {
        configured: true,
        dictionaryConfigured: false,
        dictionaryApplied: 0,
        applied: 1,
        preservedApplied: 1,
        bytes: 24,
      },
    });
    mockTranslateDocumentWithAzure.mockRejectedValueOnce(
      new IdmlError('provider rejected glossary', 'translator_rejected', 400),
    );

    await expect(
      translateFiles({
        req: request([file]),
        args: {
          source_locale: 'en',
          target_locale: 'de',
          preserve_terms: ['HERADESIGN'],
        },
      }),
    ).resolves.toMatchObject({
      report: {
        status: 'failed',
        files: [{ code: 'translator_rejected', protectedTermsRequired: true }],
      },
    });
    expect(mockTranslateDocumentWithAzure).toHaveBeenCalledTimes(1);
  });

  it('does not hide an optional-glossary transport failure', async () => {
    const file = {
      file_id: 'file-1',
      filename: 'one.pptx',
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      source: 'local',
      filepath: '/uploads/one.pptx',
    };
    mockGetFiles.mockResolvedValue([file]);
    mockGlossaryForRequest.mockResolvedValueOnce({
      entries: [{ source: 'Hello', target: 'Hallo' }],
      stats: { configured: true, applied: 1, bytes: 12 },
    });
    mockTranslateDocumentWithAzure.mockRejectedValueOnce(
      Object.assign(new Error('translator unavailable'), { code: 'translator_failed' }),
    );

    await expect(
      translateFiles({
        req: request([file]),
        args: { source_locale: 'en', target_locale: 'de' },
      }),
    ).rejects.toMatchObject({ code: 'translator_failed' });

    expect(mockTranslateDocumentWithAzure).toHaveBeenCalledTimes(1);
  });

  it('does not read or persist files after request cancellation', async () => {
    mockGetFiles.mockResolvedValue([
      {
        file_id: 'file-1',
        filename: 'one.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      translateFiles({
        req: request([{ file_id: 'file-1', filename: 'one.docx' }]),
        args: { source_locale: 'en', target_locale: 'de' },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'translation_cancelled' });

    expect(mockSaveBuffer).not.toHaveBeenCalled();
  });

  it('refuses a job pinned to a different glossary revision', async () => {
    process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION = 'current-revision';

    await expect(
      translateFiles({
        req: request([{ file_id: 'file-1', filename: 'one.docx' }]),
        args: { source_locale: 'en', target_locale: 'de' },
        expectedGlossaryRevision: 'job-revision',
      }),
    ).rejects.toMatchObject({ code: 'glossary_revision_unavailable', status: 503 });

    delete process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION;
    expect(mockGetFiles).not.toHaveBeenCalled();
  });

  it('records immediate queued-job cancellation once', async () => {
    mockGetOwnedTranslationJob.mockResolvedValue({ job_id: 'job-1', status: 'queued' });
    mockRequestTranslationCancellation.mockResolvedValue({
      job_id: 'job-1',
      status: 'cancelled',
    });

    await translationJobAction({
      req: request(),
      args: { job_id: 'job-1', action: 'cancel' },
    });

    expect(mockRecordFileTranslationOutcome).toHaveBeenCalledWith('cancelled');
  });

  it('reports when a failed durable job required protected terms', async () => {
    mockGetOwnedTranslationJob.mockResolvedValue({
      job_id: 'job-1',
      status: 'failed',
      conversation_id: 'conversation-1',
      source_locale: 'en',
      target_locale: 'de',
      attempt_count: 1,
      output_file_ids: [],
      last_error_code: 'translator_rejected',
      last_error_detail: 'Azure Translator rejected the request',
      protected_terms_required: true,
    });

    await expect(
      translationJobAction({
        req: request(),
        args: { job_id: 'job-1', action: 'status' },
      }),
    ).resolves.toMatchObject({
      report: {
        status: 'failed',
        code: 'translator_rejected',
        protectedTermsRequired: true,
      },
    });
  });

  it('does not expose or cancel a job from another conversation', async () => {
    mockGetOwnedTranslationJob.mockResolvedValue({
      job_id: 'job-1',
      status: 'completed',
      conversation_id: 'conversation-1',
      output_file_ids: ['output-1'],
    });
    const req = request();
    req.body.conversationId = 'conversation-2';

    await expect(
      translationJobAction({
        req,
        args: { job_id: 'job-1', action: 'status' },
      }),
    ).rejects.toMatchObject({ code: 'translation_job_not_found', status: 404 });
    await expect(
      translationJobAction({
        req,
        args: { job_id: 'job-1', action: 'cancel' },
      }),
    ).rejects.toMatchObject({ code: 'translation_job_not_found', status: 404 });

    expect(mockGetFiles).not.toHaveBeenCalled();
    expect(mockRequestTranslationCancellation).not.toHaveBeenCalled();
  });
});
// End [knauf]
