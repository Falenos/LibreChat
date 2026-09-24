// [knauf] KK20-297 follow-up — Ghostscript recompression of translated PDFs.
'use strict';

const fs = require('fs/promises');

jest.mock('child_process', () => ({ execFile: jest.fn() }));
const { execFile } = require('child_process');

const { compressTranslatedPdf } = require('./pdfCompression');

const ORIGINAL_ENV = { ...process.env };

function mockGhostscriptOnce(implementation) {
  execFile.mockImplementationOnce((bin, args, options, callback) => {
    implementation({ bin, args, options, callback });
  });
}

/**
 * Registers a mock that writes `content` to the `-sOutputFile=<path>` argument
 * once Ghostscript "runs". Note: awaiting this only awaits mock *registration*
 * (`mockImplementationOnce`), not the actual (fire-and-forget) write — the
 * write happens later, inside the callback, when `compressTranslatedPdf`
 * invokes the mocked `execFile`.
 */
function succeedWith(content) {
  mockGhostscriptOnce(async ({ args, callback }) => {
    const outputArg = args.find((arg) => arg.startsWith('-sOutputFile='));
    const outputPath = outputArg.slice('-sOutputFile='.length);
    await fs.writeFile(outputPath, content);
    callback(null, '', '');
  });
}

/** Ghostscript "succeeds" (exit 0) but writes no output file — a real failure mode. */
function succeedWithoutWritingOutput() {
  mockGhostscriptOnce(({ callback }) => callback(null, '', ''));
}

function failWith(error) {
  mockGhostscriptOnce(({ callback }) => callback(error, '', error.message));
}

describe('[knauf] compressTranslatedPdf', () => {
  beforeEach(() => {
    execFile.mockReset();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns the original buffer unchanged when compression is disabled', async () => {
    process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_ENABLED = 'false';
    const input = Buffer.from('%PDF-1.4 source');

    const result = await compressTranslatedPdf(input);

    expect(result).toBe(input);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns the original buffer unchanged for empty or non-buffer input', async () => {
    expect(await compressTranslatedPdf(Buffer.alloc(0))).toEqual(Buffer.alloc(0));
    expect(await compressTranslatedPdf(undefined)).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns the smaller Ghostscript output when compression succeeds', async () => {
    const input = Buffer.from('%PDF-1.4 '.repeat(50));
    const smaller = Buffer.from('%PDF-1.4 compact\n%%EOF');
    succeedWith(smaller);
    const log = { info: jest.fn(), warn: jest.fn() };

    const result = await compressTranslatedPdf(input, { log });

    expect(result).toEqual(smaller);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('compressed translated PDF'),
      expect.objectContaining({ originalBytes: input.length, compressedBytes: smaller.length }),
    );
  });

  it('falls back to the original buffer when Ghostscript output fails the PDF validity check', async () => {
    const input = Buffer.from('%PDF-1.4 '.repeat(50));
    // Smaller than the input and non-empty, but missing both the "%PDF-"
    // header and a trailing "%%EOF" — the kind of truncated/corrupt output a
    // `gs` that exits 0 without actually finishing a valid write could leave
    // behind. Must not be silently accepted just because it is smaller.
    succeedWith(Buffer.from('not a pdf'));
    const log = { info: jest.fn(), warn: jest.fn() };

    const result = await compressTranslatedPdf(input, { log });

    expect(result).toBe(input);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('falls back to the original buffer when Ghostscript output is not smaller', async () => {
    const input = Buffer.from('%PDF-1.4 small');
    const larger = Buffer.concat([input, Buffer.from('extra bytes padding')]);
    succeedWith(larger);

    const result = await compressTranslatedPdf(input);

    expect(result).toBe(input);
  });

  it('falls back to the original buffer when Ghostscript writes a zero-byte output', async () => {
    const input = Buffer.from('%PDF-1.4 source');
    succeedWith(Buffer.alloc(0));
    const log = { info: jest.fn(), warn: jest.fn() };

    const result = await compressTranslatedPdf(input, { log });

    expect(result).toBe(input);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('falls back to the original buffer when Ghostscript exits 0 but writes no output file', async () => {
    const input = Buffer.from('%PDF-1.4 source');
    succeedWithoutWritingOutput();
    const log = { info: jest.fn(), warn: jest.fn() };

    const result = await compressTranslatedPdf(input, { log });

    expect(result).toBe(input);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('compression skipped'),
      expect.objectContaining({ code: 'ENOENT' }),
    );
  });

  it('falls back to the original buffer when Ghostscript is not installed', async () => {
    const input = Buffer.from('%PDF-1.4 source');
    failWith(Object.assign(new Error('spawn gs ENOENT'), { code: 'ENOENT' }));
    const log = { info: jest.fn(), warn: jest.fn() };

    const result = await compressTranslatedPdf(input, { log });

    expect(result).toBe(input);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('compression skipped'),
      expect.objectContaining({ code: 'ENOENT' }),
    );
  });

  it('falls back to the original buffer when Ghostscript times out', async () => {
    const input = Buffer.from('%PDF-1.4 source');
    failWith(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }));

    const result = await compressTranslatedPdf(input);

    expect(result).toBe(input);
  });

  it('only honors known Ghostscript PDFSETTINGS presets, defaulting to /printer', async () => {
    process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_PRESET = 'not-a-real-preset';
    const input = Buffer.from('%PDF-1.4 source');
    succeedWith(Buffer.from('x'));

    await compressTranslatedPdf(input);

    const [, args] = execFile.mock.calls[0];
    expect(args).toContain('-dPDFSETTINGS=/printer');
  });

  it('passes through a configured allowed preset', async () => {
    process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_PRESET = '/screen';
    const input = Buffer.from('%PDF-1.4 source');
    succeedWith(Buffer.from('x'));

    await compressTranslatedPdf(input);

    const [, args] = execFile.mock.calls[0];
    expect(args).toContain('-dPDFSETTINGS=/screen');
  });

  it('pins PDF 1.7 compatibility rather than re-rendering down to 1.4', async () => {
    const input = Buffer.from('%PDF-1.4 source');
    succeedWith(Buffer.from('x'));

    await compressTranslatedPdf(input);

    const [, args] = execFile.mock.calls[0];
    expect(args).toContain('-dCompatibilityLevel=1.7');
  });

  it('defaults to lossless mode: disables image downsampling, forces Flate re-encoding, and pins JPEG/JPX passthrough', async () => {
    const input = Buffer.from('%PDF-1.4 source');
    succeedWith(Buffer.from('x'));

    await compressTranslatedPdf(input);

    const [, args] = execFile.mock.calls[0];
    expect(args).toEqual(
      expect.arrayContaining([
        '-dDownsampleColorImages=false',
        '-dDownsampleGrayImages=false',
        '-dDownsampleMonoImages=false',
        '-dAutoFilterColorImages=false',
        '-dColorImageFilter=/FlateEncode',
        '-dAutoFilterGrayImages=false',
        '-dGrayImageFilter=/FlateEncode',
        '-dPassThroughJPEGImages=true',
        '-dPassThroughJPXImages=true',
      ]),
    );
  });

  it('omits the lossless image overrides when KNAUF_TRANSLATION_PDF_COMPRESSION_QUALITY=lossy', async () => {
    process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_QUALITY = 'lossy';
    const input = Buffer.from('%PDF-1.4 source');
    succeedWith(Buffer.from('x'));

    await compressTranslatedPdf(input);

    const [, args] = execFile.mock.calls[0];
    expect(args).not.toEqual(expect.arrayContaining(['-dDownsampleColorImages=false']));
    expect(args).not.toEqual(expect.arrayContaining(['-dPassThroughJPEGImages=true']));
  });

  it('resolves the Ghostscript binary per call, not once at module load', async () => {
    const input = Buffer.from('%PDF-1.4 source');

    process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_BIN = '/opt/first/gs';
    succeedWith(Buffer.from('x'));
    await compressTranslatedPdf(input);
    expect(execFile.mock.calls[0][0]).toBe('/opt/first/gs');

    process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_BIN = '/opt/second/gs';
    succeedWith(Buffer.from('x'));
    await compressTranslatedPdf(input);
    expect(execFile.mock.calls[1][0]).toBe('/opt/second/gs');
  });

  it('forwards the resolved timeout into the execFile options', async () => {
    process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_TIMEOUT_MS = '5000';
    const input = Buffer.from('%PDF-1.4 source');
    succeedWith(Buffer.from('x'));

    await compressTranslatedPdf(input);

    const [, , options] = execFile.mock.calls[0];
    expect(options).toEqual(expect.objectContaining({ timeout: 5000 }));
  });

  it('forwards the caller signal into the execFile options', async () => {
    const input = Buffer.from('%PDF-1.4 source');
    succeedWith(Buffer.from('x'));
    const controller = new AbortController();

    await compressTranslatedPdf(input, { signal: controller.signal });

    const [, , options] = execFile.mock.calls[0];
    expect(options.signal).toBe(controller.signal);
  });

  it('rethrows instead of falling back when the caller signal is already aborted', async () => {
    const input = Buffer.from('%PDF-1.4 source');
    const controller = new AbortController();
    controller.abort();
    const abortError = Object.assign(new Error('This operation was aborted'), {
      name: 'AbortError',
    });
    failWith(abortError);
    const log = { info: jest.fn(), warn: jest.fn() };

    await expect(compressTranslatedPdf(input, { log, signal: controller.signal })).rejects.toThrow(
      'aborted',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('cleans up its temp directory after running', async () => {
    const input = Buffer.from('%PDF-1.4 source');
    let capturedInputPath;
    mockGhostscriptOnce(async ({ args, callback }) => {
      capturedInputPath = args[args.length - 1];
      const outputArg = args.find((arg) => arg.startsWith('-sOutputFile='));
      await fs.writeFile(outputArg.slice('-sOutputFile='.length), 'x');
      callback(null, '', '');
    });

    await compressTranslatedPdf(input);

    await expect(fs.access(capturedInputPath)).rejects.toThrow();
  });

  it('bounds concurrent Ghostscript spawns to KNAUF_TRANSLATION_PDF_COMPRESSION_MAX_CONCURRENT', async () => {
    process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_MAX_CONCURRENT = '1';
    const releases = [];
    let concurrentlyActive = 0;
    let maxObservedConcurrency = 0;
    execFile.mockImplementation((bin, args, options, callback) => {
      concurrentlyActive += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, concurrentlyActive);
      releases.push(async () => {
        const outputArg = args.find((arg) => arg.startsWith('-sOutputFile='));
        await fs.writeFile(outputArg.slice('-sOutputFile='.length), 'x');
        concurrentlyActive -= 1;
        callback(null, '', '');
      });
    });

    // The first call's real (unmocked) mkdtemp/writeFile happens immediately
    // since a slot is free; the second call's mkdtemp/writeFile is deferred
    // until it is handed the slot (temp files are now created only once a
    // slot is held, not while queued), so poll rather than assume a single
    // event-loop tick covers either call's I/O.
    async function waitUntil(predicate) {
      for (let i = 0; i < 200 && !predicate(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(predicate()).toBe(true);
    }

    const first = compressTranslatedPdf(Buffer.from('%PDF-1.4 one'));
    const second = compressTranslatedPdf(Buffer.from('%PDF-1.4 two'));
    await waitUntil(() => releases.length === 1);
    await releases[0]();
    await waitUntil(() => releases.length === 2);
    await releases[1]();

    await Promise.all([first, second]);
    expect(maxObservedConcurrency).toBe(1);
  });

  it('removes a queued call from the wait list and rejects it once its signal aborts, without spawning Ghostscript', async () => {
    process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_MAX_CONCURRENT = '1';
    const releases = [];
    execFile.mockImplementation((bin, args, options, callback) => {
      releases.push(async () => {
        const outputArg = args.find((arg) => arg.startsWith('-sOutputFile='));
        await fs.writeFile(outputArg.slice('-sOutputFile='.length), 'x');
        callback(null, '', '');
      });
    });

    async function waitUntil(predicate) {
      for (let i = 0; i < 200 && !predicate(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(predicate()).toBe(true);
    }

    // First call occupies the only slot and is left in-flight; the second
    // call is queued behind it, then aborted while still waiting.
    const first = compressTranslatedPdf(Buffer.from('%PDF-1.4 one'));
    await waitUntil(() => releases.length === 1);
    const controller = new AbortController();
    const second = compressTranslatedPdf(Buffer.from('%PDF-1.4 two'), {
      signal: controller.signal,
    });
    controller.abort();

    await expect(second).rejects.toThrow();
    // Only the first call's Ghostscript spawn should ever have happened —
    // the aborted, still-queued second call must never reach `execFile`.
    expect(releases.length).toBe(1);

    await releases[0]();
    await first;
  });

  it('falls back to the original buffer instead of queueing unboundedly once the wait queue is saturated', async () => {
    process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_MAX_CONCURRENT = '1';
    process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_MAX_QUEUE_DEPTH = '1';
    const releases = [];
    execFile.mockImplementation((bin, args, options, callback) => {
      releases.push(async () => {
        const outputArg = args.find((arg) => arg.startsWith('-sOutputFile='));
        await fs.writeFile(outputArg.slice('-sOutputFile='.length), 'x');
        callback(null, '', '');
      });
    });

    async function waitUntil(predicate) {
      for (let i = 0; i < 200 && !predicate(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(predicate()).toBe(true);
    }

    // First call holds the only slot; second call fills the one-deep queue;
    // a third arrival finds the queue already full and must fail fast.
    const first = compressTranslatedPdf(Buffer.from('%PDF-1.4 one'));
    await waitUntil(() => releases.length === 1);
    const second = compressTranslatedPdf(Buffer.from('%PDF-1.4 two'));
    const thirdInput = Buffer.from('%PDF-1.4 three');
    const log = { info: jest.fn(), warn: jest.fn() };
    const third = await compressTranslatedPdf(thirdInput, { log });

    expect(third).toBe(thirdInput);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('compression skipped'),
      expect.objectContaining({ code: 'GS_QUEUE_SATURATED' }),
    );

    await releases[0]();
    await waitUntil(() => releases.length === 2);
    await releases[1]();
    await Promise.all([first, second]);
  });
});
