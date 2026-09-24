// [knauf] KK20-297 follow-up — Azure Document Translation rebuilds PDFs from
// scratch (full font embedding, re-encoded images), which can multiply output
// size several times over relative to the source file. Recompress the
// translated PDF with Ghostscript before it is persisted. Best-effort: any
// failure (binary missing, timeout, malformed output, or a non-improving
// result) silently falls back to the untouched Azure output so translation
// never fails because of a compression problem.
//
// This is a Ghostscript *re-render* (pdfwrite), not a byte-patch of Azure's
// output — digital signatures, AcroForm fields, tagged/PDF-UA structure,
// optional content groups, and XMP metadata can all be altered or dropped in
// that round-trip, independent of the lossless/lossy choice below.
//
// Default mode only targets image *resolution*: pixel data and JPEG streams
// are preserved untouched (via -dPassThroughJPEGImages/-dPassThroughJPXImages)
// wherever Ghostscript's own pass-through logic allows it, so embedded text
// and brand marks (e.g. the Knauf logo) keep their resolution. Gains come
// mainly from font subsetting, stream re-compression, and removing redundant
// objects — smaller than a lossy pass, but far lower risk to fidelity. Set
// KNAUF_TRANSLATION_PDF_COMPRESSION_QUALITY=lossy to opt into Ghostscript's
// image downsampling/JPEG re-encoding for a bigger size reduction at the
// cost of visual fidelity.
'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { logger } = require('@librechat/data-schemas');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_PRESET = '/printer';
// Ghostscript's own PDFSETTINGS presets; anything else falls back to the default.
const ALLOWED_PRESETS = new Set(['/screen', '/ebook', '/printer', '/prepress', '/default']);
// Ghostscript spawns are CPU-bound for up to TIMEOUT_MS each and can carry
// hundreds of MB of RSS on large PDFs, sharing the container with the Node
// event loop. The job system already caps total active jobs globally
// (KNAUF_TRANSLATION_MAX_ACTIVE_GLOBAL, default 100) and per-file concurrency
// within a job (KNAUF_TRANSLATION_FILE_CONCURRENCY, default 1), but neither
// bounds concurrent `gs` processes specifically — this gate does, per API
// process, independent of how many jobs/files are in flight.
//
// The default is deliberately conservative and calibrated to the documented
// production worker pod: a 1 GiB pod with a 768 MiB Node heap ceiling
// (knauf/docs/implementation-plans/file-translation-production-plan.md)
// leaves roughly 256 MiB of headroom for everything that isn't the Node
// heap itself — OS/container overhead, native buffers, and any Ghostscript
// processes. At "hundreds of MB" RSS per `gs` invocation (per the comment
// above), even 2 concurrent spawns can exhaust that headroom and get the
// pod OOM-killed by the cgroup limit; the previous default of 4 could do
// so several times over. Operators who have confirmed their pod has more
// memory headroom (or run compression in an isolated process/pod) can
// raise KNAUF_TRANSLATION_PDF_COMPRESSION_MAX_CONCURRENT accordingly — this
// constant only sets the safe-by-default floor.
const DEFAULT_MAX_CONCURRENT = 1;
// Once the concurrency limit is saturated, further callers wait in an
// in-memory queue. That wait is no longer bounded by TIMEOUT_MS (which only
// covers the `gs` invocation itself once a slot is acquired), so an
// unbounded queue could in principle make a translation wait minutes for an
// optional size optimisation. Cap how many callers will wait at all; once
// the queue is this deep, treat compression the same as any other
// best-effort failure — skip it and keep the uncompressed Azure output
// rather than adding unbounded latency.
const DEFAULT_MAX_QUEUE_DEPTH = 8;

function resolveBin() {
  return process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_BIN || 'gs';
}

function resolveMaxConcurrent() {
  const configured = Number(process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_MAX_CONCURRENT);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_CONCURRENT;
}

function resolveMaxQueueDepth() {
  const configured = Number(process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_MAX_QUEUE_DEPTH);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_QUEUE_DEPTH;
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Minimal in-process counting semaphore bounding concurrent Ghostscript
 * spawns. Not distributed — each API process enforces its own ceiling — but
 * that's enough to stop a single container from running dozens of CPU-bound
 * `gs` processes at once regardless of how many translation jobs/files are
 * concurrently admitted elsewhere.
 *
 * Queued waiters are abort-aware (a cancelled call is removed from the
 * queue and rejects immediately instead of leaking a dead entry or still
 * spawning Ghostscript after cancellation) and the queue depth itself is
 * bounded (a caller arriving when the queue is already full fails fast
 * instead of waiting an unbounded amount of time for a slot).
 */
let activeCount = 0;
const waiters = [];

async function withGhostscriptSlot(fn, signal) {
  const limit = resolveMaxConcurrent();
  if (activeCount >= limit) {
    // Only relevant while a caller actually has to wait: if a slot is
    // already free we let the run proceed and rely on `execFile`'s own
    // signal handling to reject promptly, unchanged from before. The bug
    // this guards against is specifically an already-aborted signal sitting
    // in the queue for an unrelated in-flight run's entire duration and
    // still spawning Ghostscript once woken (see PR #364 review) — so the
    // check belongs here, at the point of queueing, not at entry.
    if (signal?.aborted) {
      throw abortError(signal);
    }
    if (waiters.length >= resolveMaxQueueDepth()) {
      const error = new Error('Ghostscript concurrency queue is saturated; skipping compression');
      error.code = 'GS_QUEUE_SATURATED';
      throw error;
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve: null };
      const onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
          reject(abortError(signal));
        }
        // If not found, the slot was already handed off concurrently (see
        // the release below); that resolution wins and this abort no
        // longer applies.
      };
      waiter.resolve = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.push(waiter);
    });
    // Handed the slot directly by the previous holder's `finally` below —
    // activeCount was already reserved on our behalf, so we must not
    // increment it again here.
  } else {
    activeCount += 1;
  }
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) {
      // Hand the freed slot straight to the next waiter instead of
      // decrementing then letting it race a fresh arrival to reacquire —
      // that release-then-reacquire window is where a newly arriving call
      // could otherwise jump ahead of an already-queued waiter.
      next.resolve();
    } else {
      activeCount -= 1;
    }
  }
}

function isCompressionEnabled() {
  return process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_ENABLED !== 'false';
}

// [knauf] /screen and /ebook shrink files by downsampling images to
// 72/150 DPI and re-encoding them as lossy JPEG — this visibly blurs text and
// brand marks (e.g. the Knauf logo) embedded as images, reopening the exact
// problem the dedicated logo-protection feature exists to prevent for
// standalone image translation. Opt-in only, for operators who explicitly
// accept that quality trade-off in exchange for a bigger size reduction.
function isLossyModeEnabled() {
  return process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_QUALITY === 'lossy';
}

function resolvePreset() {
  const configured = process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_PRESET;
  return configured && ALLOWED_PRESETS.has(configured) ? configured : DEFAULT_PRESET;
}

function resolveTimeoutMs() {
  const configured = Number(process.env.KNAUF_TRANSLATION_PDF_COMPRESSION_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

function buildGhostscriptArgs({ inputPath, outputPath, preset, lossy }) {
  const args = [
    '-sDEVICE=pdfwrite',
    // 1.4 forces a re-render down to PDF's oldest widely-supported feature
    // set for no benefit here; 1.7 avoids needlessly flattening transparency
    // and other newer constructs that a modern source PDF may already use.
    '-dCompatibilityLevel=1.7',
    `-dPDFSETTINGS=${preset}`,
    '-dNOPAUSE',
    '-dBATCH',
    '-dQUIET',
    '-dSAFER',
  ];
  if (!lossy) {
    // Override the preset's lossy image handling: keep original resolution
    // and re-encode losslessly. This only reclaims genuine waste (uncompressed
    // streams, redundant font subsets, duplicate objects) without touching
    // pixel data, so text and logos never degrade.
    args.push(
      '-dDownsampleColorImages=false',
      '-dDownsampleGrayImages=false',
      '-dDownsampleMonoImages=false',
      '-dAutoFilterColorImages=false',
      '-dColorImageFilter=/FlateEncode',
      '-dAutoFilterGrayImages=false',
      '-dGrayImageFilter=/FlateEncode',
      // Without these pinned explicitly, an embedded JPEG that isn't passed
      // through verbatim (pass-through is skipped when colour conversion or
      // other image processing kicks in, which /printer and friends can
      // trigger) gets decoded and re-encoded as Flate above — often *larger*
      // than the JPEG it replaced. Pinning true keeps unmodified JPEG/JPEG2000
      // streams copied as-is whenever Ghostscript's own logic allows it.
      '-dPassThroughJPEGImages=true',
      '-dPassThroughJPXImages=true',
    );
  }
  args.push(`-sOutputFile=${outputPath}`, inputPath);
  return args;
}

function runGhostscript({ inputPath, outputPath, preset, lossy, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    execFile(
      resolveBin(),
      buildGhostscriptArgs({ inputPath, outputPath, preset, lossy }),
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr: stderr?.toString?.() }));
          return;
        }
        resolve();
      },
    );
  });
}

const PDF_HEADER = Buffer.from('%PDF-');
const PDF_EOF_MARKER = '%%EOF';
// How far from the end of the file to scan for a trailing "%%EOF". A
// well-formed PDF's final marker sits at (or very near) the last bytes, but
// incremental-update trailers/whitespace can push it back slightly further
// than a bare last-line check would tolerate.
const PDF_TRAILING_SCAN_BYTES = 2048;

/**
 * Minimal structural sanity check on Ghostscript's output — not a full PDF
 * parse, just enough to catch a truncated or corrupt result before it
 * silently replaces a known-good Azure translation. Ghostscript exiting 0
 * does not guarantee a well-formed PDF was written (e.g. it can be killed
 * partway through flushing output, or hit an internal error after the exit
 * code was already determined); a real PDF always starts with a "%PDF-"
 * header and ends with at least one "%%EOF" marker, so a file missing
 * either is treated as invalid regardless of how much smaller it is.
 */
function isValidPdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PDF_HEADER.length) {
    return false;
  }
  if (!buffer.subarray(0, PDF_HEADER.length).equals(PDF_HEADER)) {
    return false;
  }
  const tailStart = Math.max(0, buffer.length - PDF_TRAILING_SCAN_BYTES);
  const tail = buffer.subarray(tailStart).toString('latin1');
  return tail.includes(PDF_EOF_MARKER);
}

/**
 * Recompresses a translated PDF with Ghostscript. Returns the original buffer
 * unchanged whenever compression is disabled, unavailable, fails, times out,
 * does not actually shrink the file, or does not pass a basic PDF validity
 * check.
 *
 * The translated document is briefly written to a `mkdtemp` (0700) directory
 * under `os.tmpdir()` so Ghostscript can read/write real files. That write
 * (and the matching cleanup in the `finally` below) happens only once the
 * Ghostscript concurrency slot has been acquired, so a call waiting in the
 * queue behind other in-flight compressions never holds a plaintext temp
 * file on disk for the duration of that wait — only for the run itself. See
 * `knauf/docs/privacy/workstream.md` for the abnormal-termination caveat
 * (SIGKILL/OOM between write and cleanup) and the assumption that the
 * deployed runtime's `/tmp` is ephemeral.
 *
 * @param {Buffer} buffer - Translated PDF bytes returned by Azure.
 * @param {{ log?: import('@librechat/data-schemas').logger, signal?: AbortSignal }} [options]
 * @returns {Promise<Buffer>}
 */
async function compressTranslatedPdf(buffer, { log = logger, signal } = {}) {
  if (!isCompressionEnabled() || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return buffer;
  }

  try {
    const compressed = await withGhostscriptSlot(async () => {
      let tmpDir;
      try {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knauf-pdf-compress-'));
        const inputPath = path.join(tmpDir, `${crypto.randomUUID()}-in.pdf`);
        const outputPath = path.join(tmpDir, `${crypto.randomUUID()}-out.pdf`);
        await fs.writeFile(inputPath, buffer);
        await runGhostscript({
          inputPath,
          outputPath,
          preset: resolvePreset(),
          lossy: isLossyModeEnabled(),
          timeoutMs: resolveTimeoutMs(),
          signal,
        });
        return await fs.readFile(outputPath);
      } finally {
        if (tmpDir) {
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }, signal);

    if (!isValidPdf(compressed) || compressed.length >= buffer.length) {
      return buffer;
    }
    log.info('[translate_file] compressed translated PDF output', {
      originalBytes: buffer.length,
      compressedBytes: compressed.length,
      reductionPct: Number((100 * (1 - compressed.length / buffer.length)).toFixed(1)),
    });
    return compressed;
  } catch (error) {
    // A cancelled job must still be reported as cancelled, not quietly
    // turned into a successful uncompressed translation by falling back.
    if (signal?.aborted) {
      throw error;
    }
    log.warn('[translate_file] PDF compression skipped; keeping uncompressed translation output', {
      message: error?.message,
      code: error?.code,
    });
    return buffer;
  }
}

module.exports = { compressTranslatedPdf };
