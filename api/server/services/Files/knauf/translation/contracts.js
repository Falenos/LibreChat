// [knauf] KK20-375 — shared format-routing and quality/fidelity contracts.
'use strict';

const path = require('path');
const { isKnaufSourceCodeFile } = require('librechat-data-provider');

const TRANSLATION_CONTRACT_VERSION = 1;
const AZURE_SYNC_INPUT_BYTES = 10 * 1024 * 1024;
const AZURE_BATCH_DOCUMENT_BYTES = 40 * 1024 * 1024;
const AZURE_BATCH_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SEGMENTED_BYTES = 25 * 1024 * 1024;

const contract = ({
  mime,
  mode,
  family,
  strategy,
  layoutValidation = 'human_required',
  fontValidation = 'human_required',
  humanReviewReasons = [],
}) =>
  Object.freeze({
    mime,
    mode,
    family,
    strategy,
    layoutValidation,
    fontValidation,
    humanReviewReasons: Object.freeze(humanReviewReasons),
  });

const FORMATS = Object.freeze({
  idml: contract({
    mime: 'application/vnd.adobe.indesign-idml-package',
    mode: 'idml',
    family: 'idml',
    strategy: 'segmented_reconstruction',
    humanReviewReasons: ['layout', 'overflow', 'font_glyphs'],
  }),
  pdf: contract({
    mime: 'application/pdf',
    mode: 'batch',
    family: 'pdf',
    strategy: 'azure_batch_document',
    humanReviewReasons: ['layout', 'overflow', 'font_glyphs'],
  }),
  docx: contract({
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    mode: 'document',
    family: 'office',
    strategy: 'azure_native_document',
    humanReviewReasons: ['layout', 'overflow', 'font_glyphs'],
  }),
  pptx: contract({
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mode: 'document',
    family: 'office',
    strategy: 'azure_native_document',
    humanReviewReasons: ['layout', 'overflow', 'font_glyphs'],
  }),
  xlsx: contract({
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    mode: 'document',
    family: 'office',
    strategy: 'azure_native_document',
    humanReviewReasons: ['layout', 'overflow', 'font_glyphs'],
  }),
  csv: contract({
    mime: 'text/csv',
    mode: 'document',
    family: 'plain_text',
    strategy: 'azure_native_document',
    layoutValidation: 'not_applicable',
    fontValidation: 'not_applicable',
  }),
  txt: contract({
    mime: 'text/plain',
    mode: 'document',
    family: 'plain_text',
    strategy: 'azure_native_document',
    layoutValidation: 'not_applicable',
    fontValidation: 'not_applicable',
  }),
  md: contract({
    mime: 'text/markdown',
    mode: 'markdown',
    family: 'structured_text',
    strategy: 'segmented_reconstruction',
    fontValidation: 'not_applicable',
    humanReviewReasons: ['rendered_layout'],
  }),
  markdown: contract({
    mime: 'text/markdown',
    mode: 'markdown',
    family: 'structured_text',
    strategy: 'segmented_reconstruction',
    fontValidation: 'not_applicable',
    humanReviewReasons: ['rendered_layout'],
  }),
  json: contract({
    mime: 'application/json',
    mode: 'json',
    family: 'structured_text',
    strategy: 'segmented_reconstruction',
    layoutValidation: 'not_applicable',
    fontValidation: 'not_applicable',
  }),
  xml: contract({
    mime: 'application/xml',
    mode: 'xml',
    family: 'structured_text',
    strategy: 'segmented_reconstruction',
    layoutValidation: 'not_applicable',
    fontValidation: 'not_applicable',
  }),
  svg: contract({
    mime: 'image/svg+xml',
    mode: 'svg',
    family: 'structured_graphic',
    strategy: 'segmented_reconstruction',
    humanReviewReasons: ['rendered_layout', 'overflow', 'font_glyphs'],
  }),
  png: contract({
    mime: 'image/png',
    mode: 'image',
    family: 'raster_image',
    strategy: 'azure_batch_image_ocr',
    humanReviewReasons: ['ocr', 'layout', 'protected_assets'],
  }),
  jpg: contract({
    mime: 'image/jpeg',
    mode: 'image',
    family: 'raster_image',
    strategy: 'azure_batch_image_ocr',
    humanReviewReasons: ['ocr', 'layout', 'protected_assets'],
  }),
  jpeg: contract({
    mime: 'image/jpeg',
    mode: 'image',
    family: 'raster_image',
    strategy: 'azure_batch_image_ocr',
    humanReviewReasons: ['ocr', 'layout', 'protected_assets'],
  }),
  webp: contract({
    mime: 'image/webp',
    mode: 'image',
    family: 'raster_image',
    strategy: 'azure_batch_image_ocr',
    humanReviewReasons: ['ocr', 'layout', 'protected_assets'],
  }),
});

const MIME_FORMATS = new Map(
  Object.entries(FORMATS).map(([extension, format]) => [format.mime, { ...format, extension }]),
);
MIME_FORMATS.set('application/csv', { ...FORMATS.csv, extension: 'csv' });
MIME_FORMATS.set('text/xml', { ...FORMATS.xml, extension: 'xml' });
MIME_FORMATS.set('image/svg', { ...FORMATS.svg, extension: 'svg' });

function formatForFile(file) {
  const filename = file?.filename ?? file?.name ?? '';
  if (isKnaufSourceCodeFile(filename, file?.type)) {
    return null;
  }
  const extension = path.extname(filename).slice(1).toLowerCase();
  return extension && FORMATS[extension]
    ? { ...FORMATS[extension], extension }
    : (MIME_FORMATS.get(file?.type) ?? null);
}

const fontValidationForFormat = (format) => format.fontValidation;

function resolveProviderRoute(format, { inputBytes = 0, glossaryRequiresBatch = false } = {}) {
  if (format.mode === 'image') {
    return { route: 'azure_batch_image_ocr', maxInputBytes: AZURE_BATCH_IMAGE_BYTES };
  }
  if (format.mode === 'batch') {
    return { route: 'azure_batch_document', maxInputBytes: AZURE_BATCH_DOCUMENT_BYTES };
  }
  if (format.mode === 'document') {
    const route =
      inputBytes > AZURE_SYNC_INPUT_BYTES || glossaryRequiresBatch
        ? 'azure_batch_document'
        : 'azure_sync_document';
    return { route, maxInputBytes: AZURE_BATCH_DOCUMENT_BYTES };
  }
  return { route: 'segmented_reconstruction', maxInputBytes: MAX_SEGMENTED_BYTES };
}

function validationContractForFormat(format) {
  return {
    contractVersion: TRANSLATION_CONTRACT_VERSION,
    format: {
      extension: format.extension,
      family: format.family,
      strategy: format.strategy,
    },
    linguistic: {
      status: 'not_evaluated',
      findings: [],
      confidence: null,
    },
    fidelity: {
      layoutValidation: format.layoutValidation,
      fontValidation: format.fontValidation,
      assetValidation: 'not_evaluated',
      overflowValidation: 'not_evaluated',
      sizeValidation: 'not_evaluated',
    },
    humanReview: {
      required: format.humanReviewReasons.length > 0,
      reasons: [...format.humanReviewReasons],
    },
  };
}

module.exports = {
  AZURE_BATCH_DOCUMENT_BYTES,
  AZURE_BATCH_IMAGE_BYTES,
  AZURE_SYNC_INPUT_BYTES,
  FORMATS,
  MAX_SEGMENTED_BYTES,
  TRANSLATION_CONTRACT_VERSION,
  fontValidationForFormat,
  formatForFile,
  resolveProviderRoute,
  validationContractForFormat,
};
