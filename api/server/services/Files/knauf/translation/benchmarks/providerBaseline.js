// [knauf] KK20-374 — Azure baseline runner for translation-fidelity benchmarks.
//
// Runs benchmark fixtures through the real Azure AI Translator paths (the same
// `translateDocumentWithAzure`/`translateWithAzure` functions production uses),
// then builds and compares output manifests against the recorded source
// manifests and approved reference text. PDF uses the same batch/blob-storage
// route as production. Image formats (PNG/JPEG/WebP) require the batch OCR
// pipeline and are reported as unsupported until that route is implemented.
'use strict';

const { parseIdml, buildIdml } = require('../../idml/core');
const {
  translateBatchWithAzure,
  translateDocumentWithAzure,
  translateWithAzure,
} = require('../providers/azure');
const { FORMATS, formatForFile } = require('../contracts');
const {
  buildBenchmarkManifest,
  compareBenchmarkManifests,
  extractBenchmarkText,
} = require('./manifest');

const UNSUPPORTED_BASELINE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const IMAGE_TEXT_EXTENSIONS = new Set(['docx', 'pptx']);

function extensionFor(filename) {
  return (filename?.split('.').pop() ?? '').toLowerCase();
}

async function translateIdmlFixture({ buffer, sourceLocale, targetLocale, signal }) {
  const parsed = await parseIdml(buffer);
  if (parsed.segments.length === 0) {
    return { buffer, providerLocale: targetLocale };
  }
  const { translations, providerLocale } = await translateWithAzure({
    segments: parsed.segments,
    sourceLocale,
    targetLocale,
    signal,
  });
  const built = await buildIdml(parsed, translations);
  return { buffer: built.buffer, providerLocale };
}

async function translateDocumentFixture({
  buffer,
  filename,
  extension,
  sourceLocale,
  targetLocale,
  signal,
}) {
  const format = FORMATS[extension];
  const mimeType = format?.mime ?? 'application/octet-stream';
  const translate = extension === 'pdf' ? translateBatchWithAzure : translateDocumentWithAzure;
  const result = await translate({
    buffer,
    filename,
    mimeType,
    sourceLocale,
    targetLocale,
    translateTextWithinImage: IMAGE_TEXT_EXTENSIONS.has(extension),
    signal,
  });
  return { buffer: result.buffer, providerLocale: result.providerLocale };
}

/**
 * Runs a single benchmark fixture through Azure and returns the translated
 * buffer. Throws for formats the harness does not yet support.
 */
async function translateFixtureWithAzure({ filename, buffer, sourceLocale, targetLocale, signal }) {
  const extension = extensionFor(filename);
  if (UNSUPPORTED_BASELINE_EXTENSIONS.has(extension)) {
    throw new TypeError(
      `Azure baseline for '.${extension}' requires the batch OCR/image pipeline ` +
        '(translateBatchWithAzure + AZURE_STORAGE_CONNECTION_STRING), which this harness ' +
        'does not implement yet.',
    );
  }
  if (extension === 'idml') {
    return translateIdmlFixture({ buffer, sourceLocale, targetLocale, signal });
  }
  if (!formatForFile({ filename })) {
    throw new TypeError(`Unsupported benchmark format for Azure baseline: ${filename}`);
  }
  return translateDocumentFixture({
    buffer,
    filename,
    extension,
    sourceLocale,
    targetLocale,
    signal,
  });
}

/**
 * Runs a fixture through Azure, builds the output manifest, and compares it
 * against the fixture's source manifest. Returns a JSON-serializable result
 * (no buffers, no credentials) suitable for persisting as baseline evidence.
 */
async function runAzureBaselineForFixture({ fixture, sourceManifest, maxSizeRatio, signal }) {
  const { buffer, providerLocale } = await translateFixtureWithAzure({
    filename: fixture.filename,
    buffer: fixture.buffer,
    sourceLocale: fixture.sourceLocale,
    targetLocale: fixture.targetLocale,
    signal,
  });
  const outputManifest = await buildBenchmarkManifest({ filename: fixture.filename, buffer });
  const comparison = compareBenchmarkManifests(sourceManifest, outputManifest, { maxSizeRatio });
  const outputText = await extractBenchmarkText({ filename: fixture.filename, buffer });
  const normalizedOutput = outputText.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const normalizedReference = (fixture.referenceText ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
  const referenceTextMatch =
    normalizedReference.length > 0 && normalizedOutput.includes(normalizedReference);
  if (!referenceTextMatch) {
    comparison.failures.push({
      code: 'approved_reference_text_missing',
      referenceTextChecked: Boolean(normalizedReference),
    });
    comparison.passed = false;
  }
  return {
    id: fixture.id,
    provider: 'azure',
    providerLocale,
    sourceLocale: fixture.sourceLocale,
    targetLocale: fixture.targetLocale,
    outputManifest,
    comparison,
  };
}

module.exports = {
  UNSUPPORTED_BASELINE_EXTENSIONS,
  runAzureBaselineForFixture,
  translateFixtureWithAzure,
};
