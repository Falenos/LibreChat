// [knauf] KK20-374 — deterministic source/output fidelity manifests.
'use strict';

const { createHash } = require('crypto');
const path = require('path');
const { Worker } = require('worker_threads');
const JSZip = require('jszip');
const sharp = require('sharp');
const { parseIdml } = require('../../idml/core');

const ZIP_FORMATS = new Set(['docx', 'pptx', 'xlsx', 'idml']);
const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const PROTECTED_PACKAGE_CATEGORIES = ['assets', 'relationships', 'styles', 'themes'];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function extensionFor(filename) {
  return path
    .extname(filename ?? '')
    .slice(1)
    .toLowerCase();
}

function packageCategory(entryName) {
  if (/(?:^|\/)(?:media|Links)\//i.test(entryName)) return 'assets';
  if (/(?:^|\/)_rels\/|\.rels$/i.test(entryName)) return 'relationships';
  if (/(?:^|\/)(?:styles\.xml|Resources\/Styles\.xml)$/i.test(entryName)) return 'styles';
  if (/(?:^|\/)(?:theme\/|Resources\/Fonts\.xml$|fontTable\.xml$)/i.test(entryName)) {
    return /font/i.test(entryName) ? 'fonts' : 'themes';
  }
  if (
    /(?:^|\/)(?:document\.xml|slides\/slide\d+\.xml|worksheets\/sheet\d+\.xml|sharedStrings\.xml|Stories\/Story_.+\.xml)$/i.test(
      entryName,
    )
  ) {
    return 'content';
  }
  return 'other';
}

function collectFontDeclarations(source) {
  const declarations = new Set();
  const patterns = [
    /(?:w:ascii|w:hAnsi|typeface|AppliedFont|FontFamily|<name\s+val)\s*=\s*["']([^"']+)["']/gi,
    /<w:font\s+w:name=["']([^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      declarations.add(match[1]);
    }
  }
  return Array.from(declarations).sort((left, right) => left.localeCompare(right, 'en'));
}

async function buildPackageManifest(buffer, extension) {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false });
  const categories = {
    assets: [],
    content: [],
    fonts: [],
    other: [],
    relationships: [],
    styles: [],
    themes: [],
  };
  const fontDeclarations = new Set();
  let textRunCount = 0;

  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const bytes = await entry.async('nodebuffer');
    const category = packageCategory(entry.name);
    categories[category].push({
      path: entry.name,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
    if (/\.xml$/i.test(entry.name)) {
      const source = bytes.toString('utf8');
      for (const font of collectFontDeclarations(source)) fontDeclarations.add(font);
      textRunCount += (source.match(/<(?:w:t|a:t|t|Content)(?:\s|>)/g) ?? []).length;
    }
  }

  const manifest = {
    entryCount: entries.length,
    categories,
    fontDeclarations: Array.from(fontDeclarations).sort((left, right) =>
      left.localeCompare(right, 'en'),
    ),
    textRunCount,
  };
  if (extension === 'idml') {
    const parsed = await parseIdml(buffer);
    manifest.idml = {
      segmentCount: parsed.segments.length,
      immutableEntryCount: parsed.immutableHashes.size,
      fontStyleManifest: parsed.fontStyleManifest,
    };
  }
  return manifest;
}

function buildPdfManifest(buffer, { timeoutMs = 10_000, WorkerImpl = Worker } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new WorkerImpl(path.join(__dirname, 'pdfManifest.worker.js'), {
      workerData: { buffer },
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      callback(value);
    };
    const timeout = setTimeout(
      () => finish(reject, new Error(`PDF benchmark inspection timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    worker.once('message', ({ manifest, error }) => {
      if (manifest) {
        finish(resolve, manifest);
      } else {
        finish(reject, Object.assign(new Error(error?.message), { name: error?.name }));
      }
    });
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => {
      if (!settled) finish(reject, new Error(`PDF benchmark worker exited with code ${code}`));
    });
  });
}

async function buildImageManifest(buffer) {
  const metadata = await sharp(buffer).metadata();
  return {
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    space: metadata.space,
    channels: metadata.channels,
    depth: metadata.depth,
    density: metadata.density ?? null,
    hasAlpha: metadata.hasAlpha,
    orientation: metadata.orientation ?? 1,
  };
}

async function buildBenchmarkManifest({ filename, buffer }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError('Benchmark input must be a non-empty Buffer');
  }
  const extension = extensionFor(filename);
  const manifest = {
    schemaVersion: 1,
    filename,
    extension,
    bytes: buffer.length,
    sha256: sha256(buffer),
  };
  if (ZIP_FORMATS.has(extension)) {
    manifest.package = await buildPackageManifest(buffer, extension);
  } else if (extension === 'pdf') {
    manifest.pdf = await buildPdfManifest(buffer);
  } else if (IMAGE_FORMATS.has(extension)) {
    manifest.image = await buildImageManifest(buffer);
  } else {
    throw new TypeError(`Unsupported benchmark format: ${extension || 'unknown'}`);
  }
  return manifest;
}

function packageEntriesByPath(entries) {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function diffFontDeclarations(sourceFonts, outputFonts) {
  const outputSet = new Set(outputFonts);
  const sourceSet = new Set(sourceFonts);
  return {
    missing: sourceFonts.filter((font) => !outputSet.has(font)),
    added: outputFonts.filter((font) => !sourceSet.has(font)),
  };
}

function compareBenchmarkManifests(source, output, { maxSizeRatio = 2 } = {}) {
  if (source.extension !== output.extension) {
    return {
      passed: false,
      sizeRatio: output.bytes / source.bytes,
      failures: [
        {
          code: 'format_changed',
          expected: source.extension,
          actual: output.extension,
        },
      ],
    };
  }
  const sizeRatio = output.bytes / source.bytes;
  const failures = [];
  if (sizeRatio > maxSizeRatio) {
    failures.push({ code: 'output_size_exceeded', maxSizeRatio, actualSizeRatio: sizeRatio });
  }
  const warnings = [];
  if (source.package && output.package) {
    for (const category of PROTECTED_PACKAGE_CATEGORIES) {
      const expected = packageEntriesByPath(source.package.categories[category]);
      const actual = packageEntriesByPath(output.package.categories[category]);
      for (const [entryPath, entry] of expected) {
        const candidate = actual.get(entryPath);
        if (!candidate) {
          failures.push({ code: 'package_entry_missing', category, path: entryPath });
        } else if (candidate.sha256 !== entry.sha256) {
          failures.push({ code: 'protected_package_entry_changed', category, path: entryPath });
        }
      }
    }
    if (source.package.textRunCount > 0 && output.package.textRunCount === 0) {
      failures.push({
        code: 'translated_content_missing',
        expectedTextRunCount: source.package.textRunCount,
        actualTextRunCount: output.package.textRunCount,
      });
    }
    const fontDelta = diffFontDeclarations(
      source.package.fontDeclarations,
      output.package.fontDeclarations,
    );
    if (fontDelta.missing.length > 0 || fontDelta.added.length > 0) {
      warnings.push({
        code: 'font_declarations_changed',
        missing: fontDelta.missing,
        added: fontDelta.added,
      });
    }
  }
  if (source.pdf && output.pdf) {
    if (source.pdf.pageCount !== output.pdf.pageCount) {
      failures.push({
        code: 'pdf_page_count_changed',
        expected: source.pdf.pageCount,
        actual: output.pdf.pageCount,
      });
    }
    source.pdf.pages.forEach((page, index) => {
      const candidate = output.pdf.pages[index];
      if (
        candidate &&
        (candidate.width !== page.width ||
          candidate.height !== page.height ||
          candidate.rotation !== page.rotation)
      ) {
        failures.push({ code: 'pdf_page_geometry_changed', pageNumber: page.pageNumber });
      }
    });
  }
  if (source.image && output.image) {
    for (const field of ['format', 'width', 'height', 'orientation']) {
      if (source.image[field] !== output.image[field]) {
        failures.push({
          code: 'image_geometry_changed',
          field,
          expected: source.image[field],
          actual: output.image[field],
        });
      }
    }
  }
  return { passed: failures.length === 0, sizeRatio, failures, warnings };
}

module.exports = {
  buildBenchmarkManifest,
  compareBenchmarkManifests,
};
