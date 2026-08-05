'use strict';

const { EventEmitter } = require('node:events');
const {
  probePdfAccess,
  PdfAccessProbeError,
  PDF_PROBE_UNAVAILABLE_CODE,
} = require('@knauf/knauf/server/pdfAccessProbe');
const { runPdfAccessProbe } = require('@knauf/knauf/server/pdfAccessProbe.worker');

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.terminate = jest.fn().mockResolvedValue(0);
    FakeWorker.instances.push(this);
  }
}
FakeWorker.instances = [];

describe('PDF access probe', () => {
  beforeEach(() => {
    FakeWorker.instances.length = 0;
  });

  it('returns the worker classification and terminates the isolate', async () => {
    const resultPromise = probePdfAccess('/tmp/readable.pdf', {
      WorkerImpl: FakeWorker,
      timeoutMs: 100,
    });
    const worker = FakeWorker.instances[0];

    worker.emit('message', { result: 'readable' });

    await expect(resultPromise).resolves.toEqual({ result: 'readable' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates a hung worker at the deadline', async () => {
    jest.useFakeTimers();
    const resultPromise = probePdfAccess('/tmp/hung.pdf', {
      WorkerImpl: FakeWorker,
      timeoutMs: 50,
    });
    const worker = FakeWorker.instances[0];

    jest.advanceTimersByTime(50);

    await expect(resultPromise).rejects.toMatchObject({
      name: 'PdfAccessProbeError',
      code: PDF_PROBE_UNAVAILABLE_CODE,
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('maps worker failures to a stable unavailable error', async () => {
    const resultPromise = probePdfAccess('/tmp/failure.pdf', {
      WorkerImpl: FakeWorker,
      timeoutMs: 100,
    });

    FakeWorker.instances[0].emit('error', new Error('worker crashed'));

    await expect(resultPromise).rejects.toBeInstanceOf(PdfAccessProbeError);
  });

  it('rejects when a worker exits without returning a result', async () => {
    const resultPromise = probePdfAccess('/tmp/no-result.pdf', {
      WorkerImpl: FakeWorker,
      timeoutMs: 100,
    });

    FakeWorker.instances[0].emit('exit', 0);

    await expect(resultPromise).rejects.toMatchObject({
      name: 'PdfAccessProbeError',
      code: PDF_PROBE_UNAVAILABLE_CODE,
    });
  });

  it.each([
    ['PasswordException', 'password_required'],
    ['InvalidPDFException', 'invalid'],
  ])('classifies %s from PDF.js as %s', async (name, expected) => {
    const loadingTask = {
      promise: Promise.reject(Object.assign(new Error(name), { name })),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      runPdfAccessProbe('/tmp/document.pdf', {
        readFile: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7')),
        loadPdfjs: jest.fn().mockResolvedValue({
          getDocument: jest.fn(() => loadingTask),
        }),
      }),
    ).resolves.toEqual({ result: expected });
    expect(loadingTask.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys both the loaded document and loading task after a readable PDF', async () => {
    const pdfDocument = { destroy: jest.fn().mockResolvedValue(undefined) };
    const loadingTask = {
      promise: Promise.resolve(pdfDocument),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      runPdfAccessProbe('/tmp/document.pdf', {
        readFile: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7')),
        loadPdfjs: jest.fn().mockResolvedValue({
          getDocument: jest.fn(() => loadingTask),
        }),
      }),
    ).resolves.toEqual({ result: 'readable' });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
    expect(loadingTask.destroy).toHaveBeenCalledTimes(1);
  });

  it('reports read, initialization, and cleanup failures as unavailable', async () => {
    await expect(
      runPdfAccessProbe('/tmp/missing.pdf', {
        readFile: jest.fn().mockRejectedValue(new Error('missing')),
      }),
    ).resolves.toEqual({ result: 'unavailable', stage: 'read' });

    await expect(
      runPdfAccessProbe('/tmp/document.pdf', {
        readFile: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7')),
        loadPdfjs: jest.fn().mockRejectedValue(new Error('import failed')),
      }),
    ).resolves.toEqual({ result: 'unavailable', stage: 'initialize' });

    const loadingTask = {
      promise: Promise.reject(Object.assign(new Error('invalid'), { name: 'InvalidPDFException' })),
      destroy: jest.fn().mockRejectedValue(new Error('cleanup failed')),
    };
    await expect(
      runPdfAccessProbe('/tmp/document.pdf', {
        readFile: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7')),
        loadPdfjs: jest.fn().mockResolvedValue({
          getDocument: jest.fn(() => loadingTask),
        }),
      }),
    ).resolves.toEqual({ result: 'unavailable', stage: 'cleanup' });
  });
});
