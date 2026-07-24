/**
 * [knauf] Agent-wide knowledge-file summary. Uses the same local/server-backed
 * rows rendered above it, so it cannot jump between upload batch IDs or claim
 * "0 of N ready" while N is still changing. Zero-value states are omitted.
 */
import type { ExtendedFile } from '~/common';
import { isIndexingPending } from '~/knauf/common/fileIndexing';
import { useLocalize } from '~/hooks';

export default function KnaufBatchIndexSummary({
  files,
  pendingFiles,
}: Readonly<{
  files: Map<string, ExtendedFile>;
  pendingFiles: Map<string, { status: 'queued' | 'uploading' | 'error' }>;
}>) {
  const localize = useLocalize();
  let ready = 0;
  let processing = 0;
  let failed = 0;
  const seen = new Set<string>();
  for (const file of files.values()) {
    if (seen.has(file.file_id)) {
      continue;
    }
    seen.add(file.file_id);
    if ((file.progress ?? 1) < 0 || file.indexing?.status === 'failed') {
      failed += 1;
    } else if ((file.progress ?? 1) < 1 || isIndexingPending(file.indexing)) {
      processing += 1;
    } else {
      ready += 1;
    }
  }
  for (const entry of pendingFiles.values()) {
    if (entry.status === 'error') {
      failed += 1;
    } else {
      processing += 1;
    }
  }
  const total = ready + processing + failed;
  if (total === 0) {
    return null;
  }
  return (
    <div
      className="flex items-center gap-2 px-2 py-1 text-xs text-text-secondary"
      data-testid="knauf-batch-index-summary"
    >
      <span>{localize('com_knauf_file_indexing_files_total', { 0: String(total) })}</span>
      {ready > 0 && (
        <span>· {localize('com_knauf_file_indexing_ready_count', { 0: String(ready) })}</span>
      )}
      {processing > 0 && (
        <span>
          · {localize('com_knauf_file_indexing_processing_count', { 0: String(processing) })}
        </span>
      )}
      {failed > 0 && (
        <span className="text-red-500">
          · {localize('com_knauf_file_indexing_failed_count', { 0: String(failed) })}
        </span>
      )}
    </div>
  );
}
// End [knauf]
