'use strict';

const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { isMainThread, parentPort, workerData } = require('node:worker_threads');

const PASSWORD_EXCEPTION = 'PasswordException';
const INVALID_PDF_EXCEPTIONS = new Set(['InvalidPDFException', 'FormatError']);

function classifyPdfError(error) {
  if (error?.name === PASSWORD_EXCEPTION) {
    return { result: 'password_required' };
  }
  if (INVALID_PDF_EXCEPTIONS.has(error?.name)) {
    return { result: 'invalid' };
  }
  return { result: 'unavailable', stage: 'parse' };
}

async function destroyProbeResources(pdfDocument, loadingTask) {
  let cleanupError;
  if (pdfDocument != null) {
    try {
      await pdfDocument.destroy();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (loadingTask != null) {
    try {
      await loadingTask.destroy();
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError != null) {
    throw cleanupError;
  }
}

async function runPdfAccessProbe(
  filePath,
  {
    readFile = fs.readFile,
    loadPdfjs = () =>
      import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href),
  } = {},
) {
  let data;
  try {
    data = await readFile(filePath);
  } catch {
    return { result: 'unavailable', stage: 'read' };
  }

  let getDocument;
  try {
    ({ getDocument } = await loadPdfjs());
  } catch {
    return { result: 'unavailable', stage: 'initialize' };
  }

  let loadingTask;
  let pdfDocument;
  let result;
  try {
    loadingTask = getDocument({
      data: new Uint8Array(data),
      isEvalSupported: false,
      verbosity: 0,
    });
    try {
      pdfDocument = await loadingTask.promise;
      result = { result: 'readable' };
    } catch (error) {
      result = classifyPdfError(error);
    }
  } catch {
    result = { result: 'unavailable', stage: 'initialize' };
  }

  try {
    await destroyProbeResources(pdfDocument, loadingTask);
  } catch {
    return { result: 'unavailable', stage: 'cleanup' };
  }
  return result;
}

if (!isMainThread) {
  runPdfAccessProbe(workerData.filePath)
    .then((result) => parentPort.postMessage(result))
    .catch(() => parentPort.postMessage({ result: 'unavailable', stage: 'worker' }));
}

module.exports = {
  runPdfAccessProbe,
  __internal__: { classifyPdfError, destroyProbeResources },
};
