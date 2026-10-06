import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { OUT_LOG, ERR_LOG } from './wrapper.js';
import type { AcaClient } from '../azure/acaClient.js';
import { ACA_FILE_MANIFEST_TRUNCATED_NAME } from '../types/aca.js';
import type { AcaSessionFile } from '../types/aca.js';
import type { BlobStore } from '../azure/blobStore.js';
import { CapturedOverwriteForbiddenError } from '../store/filesRepo.js';
import type { FilesRepo } from '../store/filesRepo.js';
import type { AuthContext, ExecResponseFile } from '../types/contract.js';
import type { ResolvedInput } from './stagePush.js';
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';

/**
 * A signature of a listed file, used to tell "same file as before" from
 * "created or changed by this exec". `lastModifiedAt` alone can be unreliable
 * across engines, so we combine it with size.
 */
export function fileSignature(
  entry: Pick<AcaSessionFile, 'sizeInBytes' | 'lastModifiedAt'>,
): string {
  return `${entry.sizeInBytes ?? ''}|${normalizeLastModified(entry.lastModifiedAt)}`;
}

function normalizeLastModified(value: string | undefined): string {
  if (value == null || value === '') {
    return '';
  }
  if (/^\d+$/.test(value)) {
    // ACA exposes file mtimes at 100 ns precision, while os.stat reports nanoseconds.
    // Truncate the wrapper value to the same resolution so an untouched file does not
    // look changed solely because of sub-100 ns filesystem digits ACA cannot represent.
    const nanoseconds = BigInt(value);
    return ((nanoseconds / 100n) * 100n).toString();
  }
  const utc = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (utc != null) {
    const epochMs = Date.parse(`${utc[1]}Z`);
    if (Number.isFinite(epochMs)) {
      const fractionNs = (utc[2] ?? '').padEnd(9, '0').slice(0, 9);
      return (BigInt(epochMs) * 1_000_000n + BigInt(fractionNs || '0')).toString();
    }
  }
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? (BigInt(epochMs) * 1_000_000n).toString() : value;
}

/** Build a name→signature map from a pre-exec file listing (see snapshotBaseline). */
export function baselineFrom(listing: AcaSessionFile[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of listing) {
    if (f.name) {
      m.set(f.name, fileSignature(f));
    }
  }
  return m;
}

/**
 * Post-exec capture: list the session's /mnt/data and return only the files
 * this exec produced — NEW files, or files whose signature changed vs the
 * pre-exec `baseline`. Persists them to Blob + Table metadata so /download outlives the
 * session cooldown. Files left over from earlier execs in the same (reused)
 * sandbox are in the baseline unchanged, so they are NOT re-returned — that
 * accumulation is the bug this guards against.
 *
 * Contract rules honored:
 *  - unchanged inputs         → echoed with inherited:true (LibreChat skips re-persist)
 *  - changed but read_only    → echoed inherited:true, modifications dropped
 *  - changed writable / new   → captured under the exec session (storage_session_id = exec sid)
 *  - pre-existing & unchanged → skipped (already delivered when first created)
 *  - `.karl_*` wrapper files  → never captured
 *  - hidden segments, `__pycache__/`, `*.pyc` → never captured (CAPTURE_IGNORE_HIDDEN)
 *  - a name owned by a read-only / foreign file → refused, reported, not replaced
 */
export async function captureOutputs(params: {
  sessionId: string;
  inputs: ResolvedInput[];
  baseline: Map<string, string>;
  baselineReliable: boolean;
  auth: AuthContext;
  config: Config;
  deps: { aca: AcaClient; blob: BlobStore; repo: FilesRepo; logger: Logger };
  signal?: AbortSignal;
}): Promise<{
  files: ExecResponseFile[];
  overflowNote: string | null;
  /** Set when a file existed in the sandbox but could not be persisted (see below). */
  failedNote: string | null;
}> {
  const { sessionId, inputs, baseline, baselineReliable, auth, config, deps, signal } = params;

  let listing: AcaSessionFile[];
  try {
    listing = await deps.aca.listFiles(sessionId, signal);
  } catch (err) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    deps.logger.warn({ err: (err as Error).message }, 'post-exec file listing failed');
    return {
      files: echoInputs(inputs),
      overflowNote: null,
      // The exec itself succeeded, so this is not a user error — but any file the code
      // wrote is now invisible, and saying nothing would present that as "produced no
      // files".
      failedNote:
        'Note: the sandbox file list could not be read after the run, so any files the ' +
        'code produced are not attached. The code itself ran successfully — re-run it to ' +
        'get the files.',
    };
  }

  const byPushedName = new Map(inputs.map((i) => [i.pushedAs, i] as const));
  const byFinalName = new Map(inputs.map((i) => [i.finalName, i] as const));
  const files: ExecResponseFile[] = [];
  const seenInputs = new Set<ResolvedInput>();

  let captured = 0;
  let capturedBytes = 0;
  let overflow = false;
  let failed = 0;
  const protectedNames: string[] = [];
  // Wall-clock deadline for the whole phase. Without it the file/byte caps still allow
  // captureMaxFiles sequential fetches at fileOpTimeoutMs each, which outlives the HTTP
  // response and loses every already-persisted file with it.
  const deadline = Date.now() + config.exec.captureMaxTotalMs;
  let timedOut = false;

  for (const entry of listing) {
    signal?.throwIfAborted();
    const name = entry.name;
    if (name === ACA_FILE_MANIFEST_TRUNCATED_NAME) {
      overflow = true;
      continue;
    }
    if (!isCapturable(name, entry, config.exec.captureIgnoreHidden)) {
      continue;
    }
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }

    const plan = planEntry(entry, name, {
      byFinalName,
      byPushedName,
      baseline,
      baselineReliable,
    });
    if (plan.input != null) {
      seenInputs.add(plan.input);
    }
    if (plan.action === 'skip') {
      continue;
    }
    if (plan.action === 'echo' && plan.input != null) {
      files.push(echoInput(plan.input));
      continue;
    }

    if (captured >= config.exec.captureMaxFiles) {
      overflow = true;
      continue;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      timedOut = true;
      break;
    }
    const result = await captureNewFile(
      entry,
      name,
      config.exec.captureMaxTotalBytes - capturedBytes,
      remainingMs,
      {
        sessionId,
        auth,
        deps,
        ...(signal != null ? { signal } : {}),
      },
    );
    if (result === 'overflow') {
      overflow = true;
    } else if (result === 'timeout') {
      timedOut = true;
      break;
    } else if (result === 'protected') {
      protectedNames.push(name);
    } else if (result == null) {
      // The file is really in the sandbox; we just could not persist it (ACA fetch, Table
      // upsert or Blob write failed). Counted so the caller can say so — dropping it
      // silently would report success with the deliverable missing.
      failed += 1;
    } else {
      captured += 1;
      capturedBytes += result.bytes;
      files.push(result.file);
    }
  }

  for (const input of inputs) {
    if (!seenInputs.has(input)) {
      files.push(echoInput(input));
    }
  }

  if (timedOut) {
    deps.logger.warn(
      { sessionId, captured, budgetMs: config.exec.captureMaxTotalMs },
      'capture budget exhausted — remaining files skipped',
    );
  }

  const failedNotes: string[] = [];
  if (failed > 0) {
    failedNotes.push(
      `Note: ${failed} file(s) the code produced could not be saved and are not attached. ` +
        'The code itself ran successfully — re-run it to try again.',
    );
  }
  if (protectedNames.length > 0) {
    failedNotes.push(
      `Note: ${protectedNames.join(', ')} could not be saved: that name belongs to a ` +
        'read-only file. Write the result under a new file name instead.',
    );
  }
  return {
    files,
    failedNote: failedNotes.length > 0 ? failedNotes.join('\n') : null,
    overflowNote: buildOverflowNote(overflow, timedOut, config),
  };
}

/**
 * One note covering both ways capture can stop short. Both are told to the model rather
 * than logged only: it just wrote those files, and silence reads as "produced none".
 */
function buildOverflowNote(overflow: boolean, timedOut: boolean, config: Config): string | null {
  if (timedOut) {
    return (
      'Note: some generated files were not captured — collecting them took longer than ' +
      `${Math.round(config.exec.captureMaxTotalMs / 1000)}s. Write fewer or smaller files, ` +
      'or produce them across separate runs.'
    );
  }
  if (overflow) {
    return `Note: some generated files were not captured (limit ${config.exec.captureMaxFiles} files / ${Math.round(config.exec.captureMaxTotalBytes / 1_048_576)} MB per execution).`;
  }
  return null;
}

/** What `captureOutputs` should do with one listing entry. */
interface EntryPlan {
  action: 'echo' | 'skip' | 'capture';
  /** The staged input this entry corresponds to, if any. */
  input: ResolvedInput | null;
}

/**
 * Decide whether a listed file is an untouched input (echo it), something already
 * delivered by an earlier exec (skip it), or this exec's work (capture it).
 *
 * The change test is deliberately signature-based, not size-based. Size alone cannot show
 * a file is untouched — rewriting `abc` to `xyz` keeps the byte count — and reporting such
 * an edit as `inherited` throws the user's modified spreadsheet away while the exec
 * reports success. The pre-exec baseline is captured after inputs are pushed precisely so
 * this comparison is possible; the size check remains only as a fallback for the case
 * where no baseline exists at all.
 *
 * A **moved** input has to be looked up under its push name, not its final one. Nested
 * inputs are pushed flat as `.karl_in_<n>` and renamed to `dir/file` by the wrapper
 * preamble, i.e. *inside* the execution and therefore after the baseline was taken. Keying
 * the lookup on the listed (final) name misses the baseline entirely and falls through to
 * the size comparison — which is exactly the same-size-rewrite bug the baseline exists to
 * prevent, just on the nested path. `rename` preserves size and mtime, so the flat entry's
 * signature is directly comparable to the renamed one.
 */
function planEntry(
  entry: AcaSessionFile,
  name: string,
  ctx: {
    byFinalName: Map<string, ResolvedInput>;
    byPushedName: Map<string, ResolvedInput>;
    baseline: Map<string, string>;
    baselineReliable: boolean;
  },
): EntryPlan {
  const input = ctx.byFinalName.get(name) ?? ctx.byPushedName.get(name) ?? null;
  const wasMoved = input != null && input.pushedAs !== input.finalName;
  const baselineSignature = ctx.baseline.get(wasMoved ? input.pushedAs : name);

  if (input != null) {
    if (!ctx.baselineReliable) {
      return { action: input.doc.readOnly ? 'echo' : 'capture', input };
    }
    const unchanged =
      baselineSignature != null
        ? baselineSignature === fileSignature(entry)
        : (entry.sizeInBytes ?? 0) === input.doc.size;
    return { action: unchanged || input.doc.readOnly ? 'echo' : 'capture', input };
  }

  if (!ctx.baselineReliable) {
    return { action: 'capture', input: null };
  }

  // Not an input, and unchanged since before this exec → already delivered.
  if (baselineSignature === fileSignature(entry)) {
    return { action: 'skip', input: null };
  }
  return { action: 'capture', input: null };
}

/**
 * Tool litter, not deliverables: a hidden segment anywhere in the path (`.~lock.x.xlsx#`,
 * `.config/libreoffice/…`), Python bytecode. Belt-and-braces with the wrapper's own walk
 * filter — a pool listing that bypasses the manifest must not reintroduce them.
 */
function isToolLitter(name: string): boolean {
  return (
    name.split('/').some((segment) => segment.startsWith('.') || segment === '__pycache__') ||
    name.endsWith('.pyc')
  );
}

/** A listing entry is capturable if it's a real, non-wrapper, non-directory file. */
function isCapturable(
  name: string | undefined,
  entry: AcaSessionFile,
  ignoreHidden: boolean,
): name is string {
  if (
    name == null ||
    name === '' ||
    name.startsWith('.karl_') ||
    name === OUT_LOG ||
    name === ERR_LOG
  ) {
    return false;
  }
  if (ignoreHidden && isToolLitter(name)) {
    return false;
  }
  return entry.type?.toLowerCase() !== 'directory';
}

interface CaptureCtx {
  sessionId: string;
  auth: AuthContext;
  deps: { aca: AcaClient; blob: BlobStore; repo: FilesRepo; logger: Logger };
  signal?: AbortSignal;
}

class CaptureOverflowError extends Error {
  constructor() {
    super('capture exceeds remaining byte budget');
    this.name = 'CaptureOverflowError';
  }
}

class CaptureTimeoutError extends Error {
  constructor() {
    super('capture exceeded its wall-clock budget');
    this.name = 'CaptureTimeoutError';
  }
}

class ByteLimitTransform extends Transform {
  bytes = 0;
  overflowed = false;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(
    chunk: Buffer | Uint8Array,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.bytes + data.length > this.maxBytes) {
      this.overflowed = true;
      callback(new CaptureOverflowError());
      return;
    }
    this.bytes += data.length;
    callback(null, data);
  }
}

/**
 * Stream one output file (bounded) to a unique Blob, commit that exact Blob
 * generation to Table metadata, and return the
 * ExecResponseFile. Returns 'overflow' if it doesn't fit the remaining budget,
 * or null if the fetch/persist failed (logged). Listing size and Content-Length
 * are only preflight hints; the transform enforces the limit on actual bytes.
 */
async function captureNewFile(
  entry: AcaSessionFile,
  name: string,
  remainingBytes: number,
  remainingMs: number,
  ctx: CaptureCtx,
): Promise<
  { file: ExecResponseFile; bytes: number } | 'overflow' | 'timeout' | 'protected' | null
> {
  const { sessionId, auth, deps, signal } = ctx;
  signal?.throwIfAborted();
  if ((entry.sizeInBytes ?? remainingBytes) > remainingBytes) {
    return 'overflow';
  }
  const candidateBlobPath = `${sessionId}/${randomUUID()}`;
  let candidateUploaded = false;
  try {
    const source = await deps.aca.fetchFileStream(sessionId, name, signal);
    if (source.contentLength != null && source.contentLength > remainingBytes) {
      source.stream.destroy();
      return 'overflow';
    }
    const limiter = new ByteLimitTransform(remainingBytes);
    let timedOut = false;
    source.stream.once('error', (error) => {
      if (!limiter.destroyed) {
        limiter.destroy(error);
      }
    });
    limiter.on('error', () => source.stream.destroy());
    source.stream.pipe(limiter);
    const abort = () => {
      source.stream.destroy(new CaptureTimeoutError());
      limiter.destroy(new CaptureTimeoutError());
    };
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      limiter.destroy(new CaptureTimeoutError());
    }, remainingMs);
    timeout.unref();
    try {
      await deps.blob.put(
        candidateBlobPath,
        limiter,
        entry.contentType ?? 'application/octet-stream',
        source.contentLength,
        signal,
      );
      candidateUploaded = true;
    } catch (error) {
      if (timedOut || error instanceof CaptureTimeoutError) {
        return 'timeout';
      }
      if (limiter.overflowed || error instanceof CaptureOverflowError) {
        return 'overflow';
      }
      source.stream.destroy();
      limiter.destroy();
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
    const { doc, obsoleteBlobPaths } = await deps.repo.upsertCaptured(
      {
        sessionId,
        filename: name,
        size: limiter.bytes,
        contentType: entry.contentType ?? 'application/octet-stream',
        origin: 'exec-output',
        readOnly: false,
        identity: { kind: 'user', id: auth.userId },
        userId: auth.userId,
        tenantId: auth.tenantId,
      },
      candidateBlobPath,
      signal,
    );
    for (const blobPath of obsoleteBlobPaths) {
      await deps.blob.delete(blobPath, signal).catch((error) => {
        deps.logger.warn(
          { blobPath, err: (error as Error).message },
          'superseded capture blob cleanup failed',
        );
      });
    }
    return {
      file: {
        id: doc.fileId,
        name: doc.filename,
        path: `/mnt/data/${doc.filename}`,
        storage_session_id: sessionId,
      },
      bytes: limiter.bytes,
    };
  } catch (err) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    if (err instanceof CapturedOverwriteForbiddenError) {
      // The refusal happens before any metadata write, so the candidate is unreferenced.
      await deps.blob.delete(candidateBlobPath, signal).catch((error) => {
        deps.logger.warn(
          { blobPath: candidateBlobPath, err: (error as Error).message },
          'refused capture blob cleanup failed',
        );
      });
      deps.logger.warn({ file: name }, 'capture refused: name belongs to a protected file');
      return 'protected';
    }
    if (candidateUploaded) {
      deps.logger.warn(
        { file: name, blobPath: candidateBlobPath },
        'retaining captured Blob after uncertain metadata commit for reaper reconciliation',
      );
    }
    deps.logger.warn({ file: name, err: (err as Error).message }, 'output capture failed');
    return null;
  }
}

function echoInput(input: ResolvedInput): ExecResponseFile {
  return {
    id: input.doc.fileId,
    // The path the client asked for, not the staged filename. They differ for an object
    // staged flat before path preservation; echoing the flat name made @librechat/agents
    // keep BOTH names for one object (it merges by id but keeps a different-named entry),
    // so the next exec pushed the same file twice.
    name: input.finalName,
    path: `/mnt/data/${input.finalName}`,
    storage_session_id: input.doc.sessionId,
    inherited: true,
  };
}

export function echoInputs(inputs: ResolvedInput[]): ExecResponseFile[] {
  return inputs.map(echoInput);
}
