import { sanitizeFilename, ValidationError } from '../validate.js';
import type { AuthContext, ExecFileRef } from '../types/contract.js';
import type { BlobStore } from '../azure/blobStore.js';
import type { FileDoc, FilesRepo } from '../store/filesRepo.js';
import type { AcaClient } from '../azure/acaClient.js';
import type { MoveInstruction } from './wrapper.js';
import type { InputCandidate, MissingRef } from './inputSelection.js';
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';

/**
 * Resolve /exec file refs against the staging store and push them into
 * the ACA session. Files with nested paths are pushed under a flat
 * `.karl_in_<n>` name; the wrapper preamble moves them into place.
 *
 * Errors surface as typed results so execService can produce the
 * contract-mandated HTTP 200 {code:1, stderr} responses instead of 5xx.
 */

export interface ResolvedInput {
  ref: ExecFileRef;
  doc: FileDoc;
  /** name pushed into the session (flat) */
  pushedAs: string;
  /** final path (relative to /mnt/data) the code expects */
  finalName: string;
}

export class StagedFileMissingError extends Error {
  constructor(public readonly filename: string) {
    super(`staged file missing: ${filename}`);
    this.name = 'StagedFileMissingError';
  }
}

export class StagedFileTooLargeError extends Error {
  constructor(public readonly filename: string) {
    super(`staged file too large: ${filename}`);
    this.name = 'StagedFileTooLargeError';
  }
}

/** Metadata reads per /exec in flight at once. Table reads only — never ACA pushes. */
const RESOLVE_CONCURRENCY = 8;

/**
 * The path the code expects for a staged object.
 *
 * Normally the staged filename. The exception is an object staged FLAT by an adapter that
 * predates path preservation (busboy stripped `karl-xlsx/references/x.md` to `x.md`): the
 * client still names it by the nested path, so when that ref name is a safe nested path
 * ending in the staged basename, the nested path wins. It only ever renames within the
 * caller's own sandbox, and only to a name the caller already used for this object.
 */
function finalNameFor(ref: ExecFileRef, doc: FileDoc): string {
  if (doc.filename.includes('/')) {
    return doc.filename;
  }
  let refName: string;
  try {
    refName = sanitizeFilename(ref.name);
  } catch {
    return doc.filename;
  }
  return refName.includes('/') && refName.slice(refName.lastIndexOf('/') + 1) === doc.filename
    ? refName
    : doc.filename;
}

/**
 * Resolve refs to staged metadata. Missing objects are collected, not thrown: whether a
 * missing file is fatal depends on whether the code names it (see inputSelection.ts).
 * Ownership violations still throw — they are tampering, not expiry.
 */
export async function resolveCandidates(
  refs: ExecFileRef[],
  auth: AuthContext,
  repo: FilesRepo,
  signal?: AbortSignal,
): Promise<{ found: InputCandidate[]; missing: MissingRef[] }> {
  const results: (InputCandidate | MissingRef)[] = new Array(refs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= refs.length) {
        return;
      }
      const ref = refs[index]!;
      const storageSid = ref.storage_session_id ?? ref.session_id;
      if (storageSid == null || ref.id == null) {
        results[index] = { ref, name: ref.name ?? 'unknown' };
        continue;
      }
      signal?.throwIfAborted();
      const doc = await repo.find(storageSid, ref.id, signal);
      if (doc == null) {
        results[index] = { ref, name: ref.name ?? ref.id };
        continue;
      }
      if (doc.identity.kind === 'user') {
        if (doc.userId !== auth.userId) {
          throw new ValidationError('forbidden', 403);
        }
      } else if (doc.tenantId !== auth.tenantId) {
        throw new ValidationError('forbidden', 403);
      }
      results[index] = { ref, doc, finalName: finalNameFor(ref, doc), index };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(RESOLVE_CONCURRENCY, refs.length) }, () => worker()),
  );
  const found: InputCandidate[] = [];
  const missing: MissingRef[] = [];
  for (const result of results) {
    if ('doc' in result) {
      found.push(result);
    } else {
      missing.push(result);
    }
  }
  return { found, missing };
}

/**
 * Nested inputs are pushed under a flat `.karl_in_<n>` name and moved into place by the
 * wrapper. Names are assigned after selection so the numbering stays dense.
 */
export function assignPushNames(candidates: InputCandidate[]): ResolvedInput[] {
  let flatIndex = 0;
  return candidates.map(({ ref, doc, finalName }) => ({
    ref,
    doc,
    finalName,
    pushedAs: finalName.includes('/') ? `.karl_in_${flatIndex++}` : finalName,
  }));
}

/** `EXEC_INPUT_SELECTION=strict`: every ref must resolve, and all of them are mounted. */
export async function resolveInputs(
  refs: ExecFileRef[],
  auth: AuthContext,
  repo: FilesRepo,
  signal?: AbortSignal,
): Promise<ResolvedInput[]> {
  const { found, missing } = await resolveCandidates(refs, auth, repo, signal);
  if (missing.length > 0) {
    throw new StagedFileMissingError(missing[0]!.name);
  }
  return assignPushNames(found);
}

export function movePlan(inputs: ResolvedInput[]): MoveInstruction[] {
  return inputs
    .filter((i) => i.pushedAs !== i.finalName)
    .map((i) => ({ from: i.pushedAs, to: i.finalName }));
}

/**
 * Push staged inputs into the ACA session **sequentially**.
 *
 * ACA dynamic-sessions file upload is NOT concurrency-safe: parallel uploads to
 * the same (cold) session clobber each other and only one file survives — which
 * one is a race. Verified live against sp-code-py-spike (Aug 2026): pushing 4
 * files with any concurrency left a single random file in /mnt/data; pushing one
 * at a time reliably lands all of them. Correctness wins over the serial cost; do NOT
 * reintroduce a worker pool here.
 *
 * Because the cost is serial, a long optional tail is bounded: once `budgetMs` has passed,
 * inputs at index >= `mandatoryCount` are skipped (and reported) rather than pushed. The
 * mandatory head — files the code names, and their siblings — is always pushed.
 */
export async function pushInputs(
  inputs: ResolvedInput[],
  sessionId: string,
  deps: { aca: AcaClient; blob: BlobStore; repo: FilesRepo; logger: Logger },
  signal?: AbortSignal,
  options: { budgetMs?: number | undefined; mandatoryCount?: number | undefined } = {},
): Promise<{ pushed: ResolvedInput[]; skipped: ResolvedInput[] }> {
  const startedAt = Date.now();
  const mandatoryCount = options.mandatoryCount ?? inputs.length;
  const pushed: ResolvedInput[] = [];
  const skipped: ResolvedInput[] = [];
  for (const [index, input] of inputs.entries()) {
    signal?.throwIfAborted();
    if (
      index >= mandatoryCount &&
      options.budgetMs != null &&
      Date.now() - startedAt > options.budgetMs
    ) {
      skipped.push(input);
      continue;
    }
    const source = await deps.blob.getStream(input.doc.blobPath, signal);
    if (source.contentLength != null && source.contentLength !== input.doc.size) {
      source.stream.destroy();
      throw new Error(`staged file size changed after metadata commit: ${input.finalName}`);
    }
    try {
      await deps.aca.pushFile(
        sessionId,
        input.pushedAs,
        source.stream,
        input.doc.size,
        input.doc.contentType,
        signal,
      );
    } catch (error) {
      source.stream.destroy();
      throw error;
    }
    pushed.push(input);
    deps.logger.debug(
      { sessionId, file: input.finalName, bytes: input.doc.size },
      'staged file pushed to session',
    );
  }
  // TTL refresh is Table-only, so it stays off the serial ACA path and can overlap.
  let nextTouch = 0;
  const toucher = async () => {
    while (nextTouch < pushed.length) {
      const input = pushed[nextTouch]!;
      nextTouch += 1;
      await deps.repo.touch(input.doc.sessionId, input.doc.fileId, signal);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(RESOLVE_CONCURRENCY, pushed.length) }, () => toucher()),
  );
  return { pushed, skipped };
}

export function validateInputBudgets(inputs: ResolvedInput[], config: Config['exec']): number {
  if (inputs.length > config.inputMaxFiles) {
    throw new ValidationError(`too many input files (maximum ${config.inputMaxFiles})`, 413);
  }
  let total = 0;
  for (const input of inputs) {
    if (input.doc.size > config.inputMaxFileBytes) {
      throw new ValidationError(`input file '${input.finalName}' exceeds the maximum size`, 413);
    }
    total += input.doc.size;
    if (total > config.inputMaxTotalBytes) {
      throw new ValidationError('aggregate input size exceeds the maximum', 413);
    }
  }
  return total;
}
