/**
 * [knauf] KK20-195 WP5a — client-side view of the async-indexing projection
 * (the `indexing` sibling the upload response and the status endpoints
 * return; plan §6.2/§6.5).
 *
 * Terminality drives the poll loop: `ready` and `failed` are terminal;
 * everything else (uploading/queued/processing) is pending and polls.
 * Files without an `indexing` projection at all are legacy/sync uploads —
 * always treated as ready (back-compat with the flag-off world).
 */
import type { ExtendedFile } from '~/common';

export interface KnaufFileIndexing {
  status: string;
  ready: boolean;
  retryable: boolean;
  error_code: string | null;
  queued_at: string | null;
}

/** Pending = a projection exists and is neither ready nor terminally failed. */
export function isIndexingPending(indexing?: KnaufFileIndexing | null): boolean {
  return indexing != null && !indexing.ready && indexing.status !== 'failed';
}

/** Terminal = no projection (legacy), ready, or failed. Polling stops here. */
export function isIndexingTerminal(indexing?: KnaufFileIndexing | null): boolean {
  return !isIndexingPending(indexing);
}

/** True when any attached file is still indexing (chat send stays disabled). */
export function hasPendingIndexing(files: Map<string, ExtendedFile>): boolean {
  for (const file of files.values()) {
    if (isIndexingPending(file.indexing)) {
      return true;
    }
  }
  return false;
}

/**
 * The submit-map filter (plan §6.5): a send must not reference a non-ready
 * initial asset — the server answers 409 `file_indexing_not_ready`. Pending
 * files are held back by the send gate; failed files are excluded here so a
 * stuck upload can never brick the conversation.
 */
export function filterIndexReadyFiles<T extends Pick<ExtendedFile, 'indexing'>>(files: T[]): T[] {
  return files.filter((file) => file.indexing == null || file.indexing.ready);
}

/** A server file-list row that may carry the WP3c `indexing` projection. */
export interface KnaufIndexedFileLike {
  embedded?: boolean;
  indexing?: KnaufFileIndexing;
  knauf_upload_batch_id?: string;
}

/**
 * KK20-195 review R10 — overlay the server's `indexing` projection (from the
 * WP3c agent-files list) onto knowledge-file entries. Upstream
 * `processAgentOption` picks explicit fields and drops it, and the
 * `agent.knowledge_files` fast path bypasses processAgentOption entirely —
 * this overlay must therefore run on BOTH branches, or a row can show
 * "Indexing…" forever with no failure/retry until reload. Pure + exported
 * for unit tests.
 */
export function overlayKnowledgeIndexing(
  entries: Array<[string, ExtendedFile]>,
  fileMap: Record<string, KnaufIndexedFileLike | undefined>,
): Array<[string, ExtendedFile]> {
  return entries.map(([id, ext]) => {
    const server = fileMap[id];
    if (server?.indexing == null) {
      return [id, ext];
    }
    return [
      id,
      {
        ...ext,
        indexing: server.indexing,
        embedded: server.embedded ?? ext.embedded,
        knauf_upload_batch_id: server.knauf_upload_batch_id,
      },
    ];
  });
}

/**
 * R10 — TanStack `refetchInterval` for the agent-files query: poll at the
 * standard cadence while any row's projection is pending, stop at rest.
 * Accepts the raw TFile[] (the `indexing` sibling is untyped upstream).
 */
export function agentFilesRefetchInterval(
  data: readonly unknown[] | undefined,
  pollMs: number,
): number | false {
  return (data ?? []).some((row) => isIndexingPending((row as KnaufIndexedFileLike).indexing))
    ? pollMs
    : false;
}
// End [knauf]
