'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DEFAULT_TIMEOUT_MS = 10_000;
const PDF_HEADER_SCAN_BYTES = 1024;
const PDF_PROBE_UNAVAILABLE_CODE = 'com_knauf_error_pdf_probe_unavailable';
const PDF_MAGIC = Buffer.from('%PDF-');
const VALID_RESULTS = new Set(['readable', 'password_required', 'invalid']);

class PdfAccessProbeError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'PdfAccessProbeError';
    this.code = PDF_PROBE_UNAVAILABLE_CODE;
  }
}

async function isPdfFileAtPath(filePath, { openFile = fs.open } = {}) {
  let handle;
  let isPdf = false;
  let operationError;
  try {
    handle = await openFile(filePath, 'r');
    const header = Buffer.alloc(PDF_HEADER_SCAN_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    isPdf = header.subarray(0, bytesRead).indexOf(PDF_MAGIC) !== -1;
  } catch (error) {
    operationError = error;
  }

  if (handle != null) {
    try {
      await handle.close();
    } catch (error) {
      operationError ??= error;
    }
  }

  if (operationError != null) {
    throw new PdfAccessProbeError(
      'PDF access probe failed to inspect the file header',
      operationError,
    );
  }
  return isPdf;
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
    let worker;
    let timeout;

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };

    try {
      worker = new WorkerImpl(workerPath, { workerData: { filePath } });
    } catch (error) {
      finish(reject, new PdfAccessProbeError('PDF access probe worker failed to start', error));
      return;
    }

    timeout = setTimeout(() => {
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
  isPdfFileAtPath,
  probePdfAccess,
  PdfAccessProbeError,
  PDF_PROBE_UNAVAILABLE_CODE,
  __internal__: { DEFAULT_TIMEOUT_MS, PDF_HEADER_SCAN_BYTES },
};
