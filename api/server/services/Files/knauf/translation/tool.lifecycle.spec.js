// [knauf] KK20-297 — output rollback and per-file failure semantics.
'use strict';

const { Readable } = require('stream');

const mockSaveBuffer = jest.fn();
const mockDeleteFile = jest.fn();
const mockGetDownloadStream = jest.fn();
const mockGetFiles = jest.fn();
const mockCreateFile = jest.fn();
const mockTranslateDocumentWithAzure = jest.fn();
const mockTranslateBatchWithAzure = jest.fn();
const mockGlossaryForRequest = jest.fn();
const mockGetOwnedTranslationJob = jest.fn();
const mockRequestTranslationCancellation = jest.fn();
const mockRecordFileTranslationOutcome = jest.fn();
const mockGetCloudFrontConfig = jest.fn();
const mockGetRetentionExpiry = jest.fn();

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
  translateBatchWithAzure: (...args) => mockTranslateBatchWithAzure(...args),
  translateDocumentWithAzure: (...args) => mockTranslateDocumentWithAzure(...args),
  translateWithAzure: jest.fn(),
}));
jest.mock('./jobs', () => ({
  ...jest.requireActual('./jobs'),
  getOwnedTranslationJob: (...args) => mockGetOwnedTranslationJob(...args),
  requestTranslationCancellation: (...args) => mockRequestTranslationCancellation(...args),
}));
jest.mock('../../retention', () => ({
  getRetentionExpiry: (...args) => mockGetRetentionExpiry(...args),
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
    mockGetRetentionExpiry.mockResolvedValue({});
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
