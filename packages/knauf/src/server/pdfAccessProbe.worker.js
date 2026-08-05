'use strict';

const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { isMainThread, parentPort, workerData } = require('node:worker_threads');

const PASSWORD_EXCEPTION = 'PasswordException';

async function destroyProbeResources(pdfDocument, loadingTask) {
  if (pdfDocument != null) {
    await pdfDocument.destroy();
  }
  if (loadingTask != null) {
    await loadingTask.destroy();
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
      result = {
        result: error?.name === PASSWORD_EXCEPTION ? 'password_required' : 'invalid',
      };
    }
  } catch {
    result = { result: 'invalid' };
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
  __internal__: { destroyProbeResources },
};
