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
 * Post-exec capture: list the session's /mnt/data, diff against pushed
 * inputs, persist new/changed writable files to blob + Mongo so
 * /download outlives the session cooldown.
 *
 * Contract rules honored:
 *  - unchanged inputs         → echoed with inherited:true (LibreChat skips re-persist)
 *  - changed but read_only    → echoed inherited:true, modifications dropped
 *  - changed writable / new   → captured under the exec session (storage_session_id = exec sid)
 *  - `.karl_*` wrapper files  → never captured
 */
export async function captureOutputs(params: {
  poolEndpoint: string;
  sessionId: string;
  inputs: ResolvedInput[];
  auth: AuthContext;
  config: Config;
  deps: { aca: AcaClient; blob: BlobStore; repo: FilesRepo; logger: Logger };
}): Promise<{ files: ExecResponseFile[]; overflowNote: string | null }> {
  const { poolEndpoint, sessionId, inputs, auth, config, deps } = params;

  let listing: AcaSessionFile[];
  try {
    listing = await deps.aca.listFiles(poolEndpoint, sessionId);
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
    if (entry.type != null && entry.type.toLowerCase() === 'directory') {
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
    }

    if (
      captured >= config.exec.captureMaxFiles ||
      capturedBytes + size > config.exec.captureMaxTotalBytes
    ) {
      overflow = true;
      continue;
    }

    try {
      const data = await deps.aca.fetchFileContent(poolEndpoint, sessionId, name);
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
