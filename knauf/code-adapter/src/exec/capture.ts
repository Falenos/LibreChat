import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { OUT_LOG, ERR_LOG } from './wrapper.js';
import type { AcaClient } from '../azure/acaClient.js';
import type { AcaSessionFile } from '../types/aca.js';
import type { BlobStore } from '../azure/blobStore.js';
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
  return `${entry.sizeInBytes ?? ''}|${entry.lastModifiedAt ?? ''}`;
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
 * pre-exec `baseline`. Persists them to blob + Mongo so /download outlives the
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
 */
export async function captureOutputs(params: {
  sessionId: string;
  inputs: ResolvedInput[];
  baseline: Map<string, string>;
  auth: AuthContext;
  config: Config;
  deps: { aca: AcaClient; blob: BlobStore; repo: FilesRepo; logger: Logger };
}): Promise<{
  files: ExecResponseFile[];
  overflowNote: string | null;
  /** Set when a file existed in the sandbox but could not be persisted (see below). */
  failedNote: string | null;
}> {
  const { sessionId, inputs, baseline, auth, config, deps } = params;

  let listing: AcaSessionFile[];
  try {
    listing = await deps.aca.listFiles(sessionId);
  } catch (err) {
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
  // Wall-clock deadline for the whole phase. Without it the file/byte caps still allow
  // captureMaxFiles sequential fetches at fileOpTimeoutMs each, which outlives the HTTP
  // response and loses every already-persisted file with it.
  const deadline = Date.now() + config.exec.captureMaxTotalMs;
  let timedOut = false;

  for (const entry of listing) {
    const name = entry.name;
    if (!isCapturable(name, entry)) {
      continue;
    }
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }

    const plan = planEntry(entry, name, { byFinalName, byPushedName, baseline });
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
      },
    );
    if (result === 'overflow') {
      overflow = true;
    } else if (result === 'timeout') {
      timedOut = true;
      break;
    } else if (result == null) {
      // The file is really in the sandbox; we just could not persist it (ACA fetch, Mongo
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

  return {
    files,
    failedNote:
      failed > 0
        ? `Note: ${failed} file(s) the code produced could not be saved and are not attached. ` +
          'The code itself ran successfully — re-run it to try again.'
        : null,
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
  },
): EntryPlan {
  const input = ctx.byFinalName.get(name) ?? ctx.byPushedName.get(name) ?? null;
  const wasMoved = input != null && input.pushedAs !== input.finalName;
  const baselineSignature = ctx.baseline.get(wasMoved ? input.pushedAs : name);

  if (input != null) {
    const unchanged =
      baselineSignature != null
        ? baselineSignature === fileSignature(entry)
        : (entry.sizeInBytes ?? 0) === input.doc.size;
    return { action: unchanged || input.doc.readOnly ? 'echo' : 'capture', input };
  }

  // Not an input, and unchanged since before this exec → already delivered.
  if (baselineSignature === fileSignature(entry)) {
    return { action: 'skip', input: null };
  }
  return { action: 'capture', input: null };
}

/** A listing entry is capturable if it's a real, non-wrapper, non-directory file. */
function isCapturable(name: string | undefined, entry: AcaSessionFile): name is string {
  if (
    name == null ||
    name === '' ||
    name.startsWith('.karl_') ||
    name === OUT_LOG ||
    name === ERR_LOG
  ) {
    return false;
  }
  return entry.type?.toLowerCase() !== 'directory';
}

interface CaptureCtx {
  sessionId: string;
  auth: AuthContext;
  deps: { aca: AcaClient; blob: BlobStore; repo: FilesRepo; logger: Logger };
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
 * generation to Mongo, and return the
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
): Promise<{ file: ExecResponseFile; bytes: number } | 'overflow' | 'timeout' | null> {
  const { sessionId, auth, deps } = ctx;
  if ((entry.sizeInBytes ?? remainingBytes) > remainingBytes) {
    return 'overflow';
  }
  const candidateBlobPath = `${sessionId}/${randomUUID()}`;
  let candidateUploaded = false;
  try {
    const source = await deps.aca.fetchFileStream(sessionId, name);
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
    );
    for (const blobPath of obsoleteBlobPaths) {
      await deps.blob.delete(blobPath).catch((error) => {
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
    if (candidateUploaded) {
      await deps.blob.delete(candidateBlobPath).catch(() => undefined);
    }
    deps.logger.warn({ file: name, err: (err as Error).message }, 'output capture failed');
    return null;
  }
}

function echoInput(input: ResolvedInput): ExecResponseFile {
  return {
    id: input.doc.fileId,
    name: input.doc.filename,
    path: `/mnt/data/${input.finalName}`,
    storage_session_id: input.doc.sessionId,
    inherited: true,
  };
}

export function echoInputs(inputs: ResolvedInput[]): ExecResponseFile[] {
  return inputs.map(echoInput);
}
