'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DEFAULT_TIMEOUT_MS = 10_000;
const PDF_PROBE_UNAVAILABLE_CODE = 'com_knauf_error_pdf_probe_unavailable';
const VALID_RESULTS = new Set(['readable', 'password_required', 'invalid']);

class PdfAccessProbeError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'PdfAccessProbeError';
    this.code = PDF_PROBE_UNAVAILABLE_CODE;
  }
}

function probePdfAccess(
  filePath,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    WorkerImpl = Worker,
    workerPath = path.join(__dirname, 'pdfAccessProbe.worker.js'),
  } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new WorkerImpl(workerPath, { workerData: { filePath } });

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };

    const timeout = setTimeout(() => {
      void worker.terminate();
      finish(reject, new PdfAccessProbeError(`PDF access probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    worker.once('message', (message) => {
      void worker.terminate();
      if (VALID_RESULTS.has(message?.result)) {
        finish(resolve, { result: message.result });
        return;
      }
      finish(
        reject,
        new PdfAccessProbeError(
          `PDF access probe failed during ${message?.stage ?? 'unknown'} stage`,
        ),
      );
    });

    worker.once('error', (error) => {
      finish(reject, new PdfAccessProbeError('PDF access probe worker failed', error));
    });

    worker.once('exit', (code) => {
      if (!settled) {
        finish(
          reject,
          new PdfAccessProbeError(
            `PDF access probe worker exited before returning a result (code ${code})`,
          ),
        );
      }
    });
  });
}

module.exports = {
  probePdfAccess,
  PdfAccessProbeError,
  PDF_PROBE_UNAVAILABLE_CODE,
  __internal__: { DEFAULT_TIMEOUT_MS },
};
