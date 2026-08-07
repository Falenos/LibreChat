import { ValidationError } from '../validate.js';
import type { AuthContext, ExecFileRef } from '../types/contract.js';
import type { BlobStore } from '../azure/blobStore.js';
import type { FileDoc, FilesRepo } from '../store/filesRepo.js';
import type { AcaClient } from '../azure/acaClient.js';
import type { PoolKind } from '../types/aca.js';
import type { MoveInstruction } from './wrapper.js';
import type { Logger } from '../logger.js';

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
): Promise<ResolvedInput[]> {
  const resolved: ResolvedInput[] = [];
  let flatIndex = 0;
  for (const ref of refs) {
    const storageSid = ref.storage_session_id ?? ref.session_id;
    if (storageSid == null || ref.id == null) {
      throw new StagedFileMissingError(ref.name ?? 'unknown');
    }
    const doc = await repo.find(storageSid, ref.id);
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

export async function pushInputs(
  inputs: ResolvedInput[],
  kind: PoolKind,
  sessionId: string,
  deps: { aca: AcaClient; blob: BlobStore; repo: FilesRepo; logger: Logger },
): Promise<void> {
  const CONCURRENCY = 4;
  const queue = [...inputs];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const input = queue.shift();
      if (input == null) {
        return;
      }
      const data = await deps.blob.getBuffer(input.doc.blobPath);
      await deps.aca.pushFile(kind, sessionId, input.pushedAs, data, input.doc.contentType);
      await deps.repo.touch(input.doc.sessionId, input.doc.fileId);
      deps.logger.debug(
        { sessionId, file: input.finalName, bytes: data.length },
        'staged file pushed to session',
      );
    }
  });
  await Promise.all(workers);
}
