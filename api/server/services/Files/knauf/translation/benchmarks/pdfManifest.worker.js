// [knauf] KK20-374 — isolate ESM-only PDF.js benchmark inspection.
'use strict';

const { pathToFileURL } = require('node:url');
const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function buildPdfManifest(buffer, { loadPdfjs } = {}) {
  const loader =
    loadPdfjs ??
    (() => import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href));
  const { getDocument } = await loader();
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  const document = await loadingTask.promise;
  const pages = [];
  const fonts = new Set();
  let textItemCount = 0;
  let textCharacterCount = 0;
  const textHashes = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const text = await page.getTextContent();
      const values = text.items.filter((item) => typeof item.str === 'string');
      for (const item of values) {
        if (item.fontName) fonts.add(text.styles[item.fontName]?.fontFamily ?? item.fontName);
      }
      textItemCount += values.length;
      textCharacterCount += values.reduce((total, item) => total + item.str.length, 0);
      textHashes.push(sha256(Buffer.from(values.map((item) => item.str).join('\u001f'))));
      pages.push({
        pageNumber,
        width: Number(viewport.width.toFixed(3)),
        height: Number(viewport.height.toFixed(3)),
        rotation: viewport.rotation,
        textItemCount: values.length,
      });
      page.cleanup();
    }
  } finally {
    await document.destroy();
    await loadingTask.destroy();
  }
  return {
    pageCount: pages.length,
    pages,
    fonts: Array.from(fonts).sort((left, right) => left.localeCompare(right, 'en')),
    textItemCount,
    textCharacterCount,
    textSha256: sha256(Buffer.from(textHashes.join(':'))),
  };
}

if (!isMainThread) {
  buildPdfManifest(Buffer.from(workerData.buffer))
    .then((manifest) => parentPort.postMessage({ manifest }))
    .catch((error) =>
      parentPort.postMessage({
        error: {
          name: error?.name ?? 'Error',
          message: error?.message ?? 'PDF manifest generation failed',
        },
      }),
    );
}

module.exports = {
  buildPdfManifest,
};
