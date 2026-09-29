// [knauf] KK20-374 — benchmark fixture and manifest regressions.
'use strict';

const JSZip = require('jszip');
const mammoth = require('mammoth');
const { BENCHMARK_CASES, buildBenchmarkFixtures } = require('./fixtures');
const { buildBenchmarkManifest, compareBenchmarkManifests } = require('./manifest');

describe('[knauf] translation fidelity benchmarks', () => {
  let fixtures;
  let manifests;

  beforeAll(async () => {
    fixtures = await buildBenchmarkFixtures();
    manifests = new Map(
      await Promise.all(
        fixtures.map(async (fixture) => [fixture.id, await buildBenchmarkManifest(fixture)]),
      ),
    );
  });

  it('covers every umbrella-story format with linguistic references', () => {
    expect(BENCHMARK_CASES.map((fixture) => fixture.filename.split('.').pop()).sort()).toEqual([
      'docx',
      'idml',
      'jpeg',
      'pdf',
      'png',
      'pptx',
      'webp',
      'xlsx',
    ]);
    expect(
      BENCHMARK_CASES.every(
        (fixture) =>
          fixture.sourceLocale &&
          fixture.targetLocale &&
          fixture.referenceText &&
          fixture.protectedTerms.length > 0,
      ),
    ).toBe(true);
    expect(BENCHMARK_CASES.some((fixture) => fixture.targetLocale === 'ar')).toBe(true);
  });

  it('records deterministic package, font, style, asset, and content evidence', () => {
    for (const id of ['office-docx-de', 'office-pptx-ar', 'office-xlsx-de', 'idml-styles-de']) {
      const manifest = manifests.get(id);
      expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.package.entryCount).toBeGreaterThan(4);
      expect(manifest.package.categories.content.length).toBeGreaterThan(0);
      expect(manifest.package.categories.assets.length).toBeGreaterThan(0);
      expect(manifest.package.fontDeclarations).toContain('Arial');
      expect(manifest.package.textRunCount).toBeGreaterThan(0);
    }
    for (const id of ['office-docx-de', 'office-pptx-ar', 'office-xlsx-de']) {
      expect(manifests.get(id).package.categories.relationships.length).toBeGreaterThan(0);
    }
    expect(manifests.get('idml-styles-de').package.idml).toMatchObject({
      segmentCount: 1,
      immutableEntryCount: 4,
    });
  });

  it('produces a DOCX whose text is readable by a standard document parser', async () => {
    const fixture = fixtures.find(({ id }) => id === 'office-docx-de');
    const parsed = await mammoth.extractRawText({ buffer: fixture.buffer });

    expect(parsed.value).toContain('Agentic Karl helps Knauf translate documents.');
    expect(parsed.value).toContain('Panel thickness: 12.5 mm');
    expect(parsed.messages).toEqual([]);
  });

  it('records PDF page geometry, text, and font evidence', () => {
    expect(manifests.get('pdf-layout-de').pdf).toMatchObject({
      pageCount: 1,
      textItemCount: 1,
      textCharacterCount: 25,
      pages: [{ pageNumber: 1, width: 300, height: 200, rotation: 0, textItemCount: 1 }],
    });
    expect(manifests.get('pdf-layout-de').pdf.fonts).toContain('sans-serif');
  });

  it.each([
    ['image-png-de', 'png'],
    ['image-jpeg-de', 'jpeg'],
    ['image-webp-ar', 'webp'],
  ])('records stable image geometry for %s', (id, format) => {
    expect(manifests.get(id).image).toMatchObject({
      format,
      width: 320,
      height: 180,
      orientation: 1,
    });
  });

  it('accepts an unchanged source within its size threshold', () => {
    const source = manifests.get('office-docx-de');
    expect(compareBenchmarkManifests(source, source, { maxSizeRatio: 1 })).toEqual({
      passed: true,
      sizeRatio: 1,
      failures: [],
      warnings: [],
    });
  });

  it('reports protected package changes and excessive output growth', async () => {
    const fixture = fixtures.find(({ id }) => id === 'office-docx-de');
    const zip = await JSZip.loadAsync(fixture.buffer);
    zip.file('word/media/knauf.png', Buffer.alloc(4096, 7));
    const changedBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    const output = await buildBenchmarkManifest({
      filename: fixture.filename,
      buffer: changedBuffer,
    });
    const comparison = compareBenchmarkManifests(manifests.get(fixture.id), output, {
      maxSizeRatio: 1,
    });

    expect(comparison.passed).toBe(false);
    expect(comparison.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'protected_package_entry_changed',
          category: 'assets',
          path: 'word/media/knauf.png',
        }),
        expect.objectContaining({ code: 'output_size_exceeded' }),
      ]),
    );
  });

  it('reports image geometry changes', async () => {
    const fixture = fixtures.find(({ id }) => id === 'image-png-de');
    const resized = await require('sharp')(fixture.buffer).resize(300, 180).png().toBuffer();
    const output = await buildBenchmarkManifest({ filename: fixture.filename, buffer: resized });
    const comparison = compareBenchmarkManifests(manifests.get(fixture.id), output);

    expect(comparison).toMatchObject({ passed: false });
    expect(comparison.failures).toContainEqual({
      code: 'image_geometry_changed',
      field: 'width',
      expected: 320,
      actual: 300,
    });
  });

  it('fails a translated DOCX that drops all translatable text and flags substituted fonts', async () => {
    const fixture = fixtures.find(({ id }) => id === 'office-docx-de');
    const zip = await JSZip.loadAsync(fixture.buffer);
    const documentXml = await zip.file('word/document.xml').async('string');
    const blankedDocument = documentXml.replace(/<w:t[^>]*>.*?<\/w:t>/gs, '');
    zip.file('word/document.xml', blankedDocument);
    const fontTableXml = await zip.file('word/fontTable.xml').async('string');
    zip.file('word/fontTable.xml', fontTableXml.replace(/Arial/g, 'SubstitutedFont'));
    const blankedBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    const output = await buildBenchmarkManifest({
      filename: fixture.filename,
      buffer: blankedBuffer,
    });
    const comparison = compareBenchmarkManifests(manifests.get(fixture.id), output, {
      maxSizeRatio: 2,
    });

    expect(output.package.textRunCount).toBe(0);
    expect(comparison.passed).toBe(false);
    expect(comparison.failures).toContainEqual(
      expect.objectContaining({
        code: 'translated_content_missing',
        actualTextRunCount: 0,
      }),
    );
    expect(comparison.warnings).toContainEqual(
      expect.objectContaining({
        code: 'font_declarations_changed',
        added: expect.arrayContaining(['SubstitutedFont']),
      }),
    );
  });
});
