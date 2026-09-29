// [knauf] KK20-374 — Azure baseline runner regressions.
'use strict';

const { buildBenchmarkFixtures } = require('./fixtures');
const { buildBenchmarkManifest } = require('./manifest');
const JSZip = require('jszip');
const {
  UNSUPPORTED_BASELINE_EXTENSIONS,
  runAzureBaselineForFixture,
  translateFixtureWithAzure,
} = require('./providerBaseline');

jest.mock('../providers/azure', () => ({
  translateBatchWithAzure: jest.fn(),
  translateDocumentWithAzure: jest.fn(),
  translateWithAzure: jest.fn(),
}));

const {
  translateBatchWithAzure,
  translateDocumentWithAzure,
  translateWithAzure,
} = require('../providers/azure');

describe('[knauf] Azure translation-fidelity baseline runner', () => {
  let fixtures;

  beforeAll(async () => {
    fixtures = await buildBenchmarkFixtures();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects image formats that require the batch OCR pipeline', async () => {
    expect(UNSUPPORTED_BASELINE_EXTENSIONS.has('png')).toBe(true);
    const fixture = fixtures.find(({ id }) => id === 'image-png-de');

    await expect(
      translateFixtureWithAzure({
        filename: fixture.filename,
        buffer: fixture.buffer,
        sourceLocale: fixture.sourceLocale,
        targetLocale: fixture.targetLocale,
      }),
    ).rejects.toThrow(/batch OCR\/image pipeline/);
    expect(translateDocumentWithAzure).not.toHaveBeenCalled();
  });

  it('routes Office fixtures through the synchronous document endpoint', async () => {
    const fixture = fixtures.find(({ id }) => id === 'office-docx-de');
    translateDocumentWithAzure.mockResolvedValue({
      buffer: fixture.buffer,
      providerLocale: 'de',
      batches: 1,
    });

    const result = await translateFixtureWithAzure({
      filename: fixture.filename,
      buffer: fixture.buffer,
      sourceLocale: fixture.sourceLocale,
      targetLocale: fixture.targetLocale,
    });

    expect(result).toEqual({ buffer: fixture.buffer, providerLocale: 'de' });
    expect(translateDocumentWithAzure).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: fixture.filename,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sourceLocale: 'en',
        targetLocale: 'de',
        translateTextWithinImage: true,
      }),
    );
    expect(translateWithAzure).not.toHaveBeenCalled();
  });

  it('routes PDF fixtures through the production batch endpoint', async () => {
    const fixture = fixtures.find(({ id }) => id === 'pdf-layout-de');
    translateBatchWithAzure.mockResolvedValue({
      buffer: fixture.buffer,
      providerLocale: 'de',
      batches: 1,
    });

    const result = await translateFixtureWithAzure({
      filename: fixture.filename,
      buffer: fixture.buffer,
      sourceLocale: fixture.sourceLocale,
      targetLocale: fixture.targetLocale,
    });

    expect(result).toEqual({ buffer: fixture.buffer, providerLocale: 'de' });
    expect(translateBatchWithAzure).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: fixture.filename,
        mimeType: 'application/pdf',
        sourceLocale: 'en',
        targetLocale: 'de',
      }),
    );
    expect(translateDocumentWithAzure).not.toHaveBeenCalled();
  });

  it('routes IDML fixtures through segment-based translation', async () => {
    const fixture = fixtures.find(({ id }) => id === 'idml-styles-de');
    translateWithAzure.mockResolvedValue({
      translations: new Map([['s0-c0', 'Agentic Karl hilft Knauf.']]),
      providerLocale: 'de',
    });

    await translateFixtureWithAzure({
      filename: fixture.filename,
      buffer: fixture.buffer,
      sourceLocale: fixture.sourceLocale,
      targetLocale: fixture.targetLocale,
    });

    expect(translateDocumentWithAzure).not.toHaveBeenCalled();
    expect(translateWithAzure).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLocale: 'en', targetLocale: 'de' }),
    );
  });

  it('produces a passing comparison when Azure returns the approved reference text', async () => {
    const fixture = fixtures.find(({ id }) => id === 'office-docx-de');
    const sourceManifest = await buildBenchmarkManifest(fixture);
    const zip = await JSZip.loadAsync(fixture.buffer);
    const documentXml = await zip.file('word/document.xml').async('string');
    const translatedBuffer = await zip
      .file(
        'word/document.xml',
        documentXml.replace('Agentic Karl helps Knauf translate documents.', fixture.referenceText),
      )
      .generateAsync({ type: 'nodebuffer' });
    translateDocumentWithAzure.mockResolvedValue({
      buffer: translatedBuffer,
      providerLocale: 'de',
      batches: 1,
    });

    const result = await runAzureBaselineForFixture({
      fixture,
      sourceManifest,
      maxSizeRatio: 2,
    });

    expect(result.provider).toBe('azure');
    expect(result.comparison.passed).toBe(true);
    expect(result.comparison.failures).toEqual([]);
  });

  it('flags an Azure baseline that drops all translatable content', async () => {
    const fixture = fixtures.find(({ id }) => id === 'office-docx-de');
    const sourceManifest = await buildBenchmarkManifest(fixture);
    const zip = await JSZip.loadAsync(fixture.buffer);
    const documentXml = await zip.file('word/document.xml').async('string');
    zip.file('word/document.xml', documentXml.replace(/<w:t[^>]*>.*?<\/w:t>/gs, ''));
    const blankedBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    translateDocumentWithAzure.mockResolvedValue({
      buffer: blankedBuffer,
      providerLocale: 'de',
      batches: 1,
    });

    const result = await runAzureBaselineForFixture({
      fixture,
      sourceManifest,
      maxSizeRatio: 2,
    });

    expect(result.comparison.passed).toBe(false);
    expect(result.comparison.failures).toContainEqual(
      expect.objectContaining({ code: 'translated_content_missing' }),
    );
  });
});
