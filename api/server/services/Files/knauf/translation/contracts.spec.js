// [knauf] KK20-375 — format-routing and shared validation contract regressions.
'use strict';

const {
  AZURE_SYNC_INPUT_BYTES,
  formatForFile,
  resolveProviderRoute,
  validationContractForFormat,
} = require('./contracts');

describe('[knauf] translation routing contracts', () => {
  it.each([
    ['sample.docx', 'office', 'azure_native_document'],
    ['sample.pptx', 'office', 'azure_native_document'],
    ['sample.xlsx', 'office', 'azure_native_document'],
    ['sample.pdf', 'pdf', 'azure_batch_document'],
    ['sample.png', 'raster_image', 'azure_batch_image_ocr'],
    ['sample.jpeg', 'raster_image', 'azure_batch_image_ocr'],
    ['sample.webp', 'raster_image', 'azure_batch_image_ocr'],
    ['sample.idml', 'idml', 'segmented_reconstruction'],
  ])('maps %s to its supported family and strategy', (filename, family, strategy) => {
    expect(formatForFile({ filename })).toMatchObject({ family, strategy });
  });

  it('selects synchronous and batch native-document routes at explicit boundaries', () => {
    const format = formatForFile({ filename: 'sample.docx' });

    expect(resolveProviderRoute(format, { inputBytes: AZURE_SYNC_INPUT_BYTES })).toMatchObject({
      route: 'azure_sync_document',
    });
    expect(resolveProviderRoute(format, { inputBytes: AZURE_SYNC_INPUT_BYTES + 1 })).toMatchObject({
      route: 'azure_batch_document',
    });
    expect(resolveProviderRoute(format, { glossaryRequiresBatch: true })).toMatchObject({
      route: 'azure_batch_document',
    });
  });

  it('defines additive validation fields without claiming unperformed checks', () => {
    expect(validationContractForFormat(formatForFile({ filename: 'sample.idml' }))).toEqual({
      contractVersion: 1,
      format: {
        extension: 'idml',
        family: 'idml',
        strategy: 'segmented_reconstruction',
      },
      linguistic: {
        status: 'not_evaluated',
        findings: [],
        confidence: null,
      },
      fidelity: {
        layoutValidation: 'human_required',
        fontValidation: 'human_required',
        assetValidation: 'not_evaluated',
        overflowValidation: 'not_evaluated',
        sizeValidation: 'not_evaluated',
      },
      humanReview: {
        required: true,
        reasons: ['layout', 'overflow', 'font_glyphs'],
      },
    });
  });
});
