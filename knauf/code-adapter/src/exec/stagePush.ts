import { ValidationError } from '../validate.js';
import type { AuthContext, ExecFileRef } from '../types/contract.js';
import type { BlobStore } from '../azure/blobStore.js';
import type { FileDoc, FilesRepo } from '../store/filesRepo.js';
import type { AcaClient } from '../azure/acaClient.js';
import type { MoveInstruction } from './wrapper.js';
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

export async function resolveInputs(
  refs: ExecFileRef[],
  auth: AuthContext,
  repo: FilesRepo,
  signal?: AbortSignal,
): Promise<ResolvedInput[]> {
  const resolved: ResolvedInput[] = [];
  let flatIndex = 0;
  for (const ref of refs) {
    const storageSid = ref.storage_session_id ?? ref.session_id;
    if (storageSid == null || ref.id == null) {
      throw new StagedFileMissingError(ref.name ?? 'unknown');
    }
    signal?.throwIfAborted();
    const doc = await repo.find(storageSid, ref.id, signal);
    if (doc == null) {
      throw new StagedFileMissingError(ref.name ?? ref.id);
    }
    if (doc.identity.kind === 'user') {
      if (doc.userId !== auth.userId) {
        throw new ValidationError('forbidden', 403);
      }
    } else if (doc.tenantId !== auth.tenantId) {
      throw new ValidationError('forbidden', 403);
    }
    const finalName = doc.filename;
    const needsMove = finalName.includes('/');
    const pushedAs = needsMove ? `.karl_in_${flatIndex++}` : finalName;
    resolved.push({ ref, doc, pushedAs, finalName });
  }
  return resolved;
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
 * at a time reliably lands all of them. Uploads are few and small, so the serial
 * cost is negligible; correctness wins. Do NOT reintroduce a worker pool here.
 */
export async function pushInputs(
  inputs: ResolvedInput[],
  sessionId: string,
  deps: { aca: AcaClient; blob: BlobStore; repo: FilesRepo; logger: Logger },
  signal?: AbortSignal,
): Promise<void> {
  for (const input of inputs) {
    signal?.throwIfAborted();
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
    await deps.repo.touch(input.doc.sessionId, input.doc.fileId, signal);
    deps.logger.debug(
      { sessionId, file: input.finalName, bytes: input.doc.size },
      'staged file pushed to session',
    );
  }
}

export function validateInputBudgets(
  inputs: ResolvedInput[],
  config: Config['exec'],
): number {
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
