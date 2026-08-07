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
    if (
      name == null ||
      name === '' ||
      name.startsWith('.karl_') ||
      name === OUT_LOG ||
      name === ERR_LOG
    ) {
      continue;
    }
    if (entry.type?.toLowerCase() === 'directory') {
      continue;
    }

    const input = byFinalName.get(name) ?? byPushedName.get(name);
    const size = entry.sizeInBytes ?? 0;

    if (input != null) {
      seenInputs.add(input);
      const unchanged = size === input.doc.size;
      if (unchanged || input.doc.readOnly) {
        files.push(echoInput(input));
        continue;
      }
    } else {
      // Not an input to this exec: only return it if it's new or changed vs the
      // pre-exec baseline. Unchanged pre-existing files were delivered already.
      const baseSig = baseline.get(name);
      if (baseSig != null && baseSig === fileSignature(entry)) {
        continue;
      }
    }

    if (
      captured >= config.exec.captureMaxFiles ||
      capturedBytes + size > config.exec.captureMaxTotalBytes
    ) {
      overflow = true;
      continue;
    }

    try {
      const data = await deps.aca.fetchFileContent(sessionId, name);
      const doc = await deps.repo.upsertCaptured({
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
      await deps.blob.put(doc.blobPath, data, doc.contentType);
      captured += 1;
      capturedBytes += data.length;
      files.push({
        id: doc.fileId,
        name: doc.filename,
        path: `/mnt/data/${doc.filename}`,
        storage_session_id: sessionId,
      });
    } catch (err) {
      deps.logger.warn({ file: name, err: (err as Error).message }, 'output capture failed');
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
