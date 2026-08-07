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
}): Promise<{ files: ExecResponseFile[]; overflowNote: string | null }> {
  const { sessionId, inputs, baseline, auth, config, deps } = params;

  let listing: AcaSessionFile[];
  try {
    listing = await deps.aca.listFiles(sessionId);
  } catch (err) {
    deps.logger.warn({ err: (err as Error).message }, 'post-exec file listing failed');
    return { files: echoInputs(inputs), overflowNote: null };
  }

  const byPushedName = new Map(inputs.map((i) => [i.pushedAs, i] as const));
  const byFinalName = new Map(inputs.map((i) => [i.finalName, i] as const));
  const files: ExecResponseFile[] = [];
  const seenInputs = new Set<ResolvedInput>();

  let captured = 0;
  let capturedBytes = 0;
  let overflow = false;

  for (const entry of listing) {
    const name = entry.name;
    if (!isCapturable(name, entry)) {
      continue;
    }

    const input = byFinalName.get(name) ?? byPushedName.get(name);
    if (input != null) {
      seenInputs.add(input);
      const unchanged = (entry.sizeInBytes ?? 0) === input.doc.size;
      if (unchanged || input.doc.readOnly) {
        files.push(echoInput(input));
        continue;
      }
    } else if (baseline.get(name) === fileSignature(entry)) {
      // Not an input, and unchanged since before this exec → already delivered.
      continue;
    }

    if (captured >= config.exec.captureMaxFiles) {
      overflow = true;
      continue;
    }
    const result = await captureNewFile(
      entry,
      name,
      config.exec.captureMaxTotalBytes - capturedBytes,
      {
        sessionId,
        auth,
        deps,
      },
    );
    if (result === 'overflow') {
      overflow = true;
    } else if (result != null) {
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

  return {
    files,
    overflowNote: overflow
      ? `Note: some generated files were not captured (limit ${config.exec.captureMaxFiles} files / ${Math.round(config.exec.captureMaxTotalBytes / 1_048_576)} MB per execution).`
      : null,
  };
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

/**
 * Fetch one output file (bounded), persist it to blob + Mongo, and return the
 * ExecResponseFile. Returns 'overflow' if it doesn't fit the remaining budget,
 * or null if the fetch/persist failed (logged). A missing sizeInBytes is
 * treated as the whole remaining budget so an unsized entry can't slip the cap,
 * and the fetch itself is hard-capped as defense in depth.
 */
async function captureNewFile(
  entry: AcaSessionFile,
  name: string,
  remainingBytes: number,
  ctx: CaptureCtx,
): Promise<{ file: ExecResponseFile; bytes: number } | 'overflow' | null> {
  const { sessionId, auth, deps } = ctx;
  if ((entry.sizeInBytes ?? remainingBytes) > remainingBytes) {
    return 'overflow';
  }
  try {
    const data = await deps.aca.fetchFileContent(sessionId, name, remainingBytes + 1);
    if (data.length > remainingBytes) {
      return 'overflow';
    }
    const { doc, inserted } = await deps.repo.upsertCaptured({
      sessionId,
      filename: name,
      size: data.length,
      contentType: entry.contentType ?? 'application/octet-stream',
      origin: 'exec-output',
      readOnly: false,
      identity: { kind: 'user', id: auth.userId },
      userId: auth.userId,
      tenantId: auth.tenantId,
    });
    try {
      await deps.blob.put(doc.blobPath, data, doc.contentType);
    } catch (putErr) {
      // Don't leave a row pointing at a blob that never landed. Only roll back a
      // freshly inserted row — an updated row still has its prior valid blob.
      if (inserted) {
        await deps.repo.delete(sessionId, doc.fileId).catch(() => undefined);
      }
      throw putErr;
    }
    return {
      file: {
        id: doc.fileId,
        name: doc.filename,
        path: `/mnt/data/${doc.filename}`,
        storage_session_id: sessionId,
      },
      bytes: data.length,
    };
  } catch (err) {
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
