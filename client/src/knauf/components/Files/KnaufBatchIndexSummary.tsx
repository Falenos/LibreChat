/**
 * [knauf] KK20-195 WP5b — the §6.3 aggregate multi-file summary: one
 * owner-scoped batch query, one polling response ("X of Y files ready",
 * plus a failed count). Renders only while the batch is NON-terminal —
 * per-row states take over once everything settles — and polls at the same
 * 5-second cadence as the per-file loop, stopping on `terminal`.
 *
 * The batch id comes from the files the caller passes (stamped client-side
 * on every multi-file selection, WP5b); with no pending batch this renders
 * nothing and performs no requests.
 */
import { useEffect, useMemo, useState } from 'react';
import { Spinner } from '@librechat/client';
import type { ExtendedFile } from '~/common';
import {
  getBatchIndexStatus,
  type BatchIndexStatusResponse,
} from '~/knauf/data-provider/data-service';
import { KNAUF_INDEX_POLL_MS } from '~/knauf/hooks/Files/useKnaufIndexStatus';
import { isIndexingPending } from '~/knauf/common/fileIndexing';
import { useLocalize } from '~/hooks';

export default function KnaufBatchIndexSummary({
  files,
}: Readonly<{ files: Map<string, ExtendedFile> }>) {
  const localize = useLocalize();
  const [summary, setSummary] = useState<BatchIndexStatusResponse | null>(null);

  // The first batch that still has a pending member; null once all settled.
  const pendingBatchId = useMemo(() => {
    for (const file of files.values()) {
      if (file.knauf_upload_batch_id && isIndexingPending(file.indexing)) {
        return file.knauf_upload_batch_id;
      }
    }
    return null;
  }, [files]);

  useEffect(() => {
    if (pendingBatchId == null) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      const result = await getBatchIndexStatus(pendingBatchId).catch(() => null);
      if (cancelled || result == null) {
        return;
      }
      setSummary(result);
      if (result.terminal && timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };

    tick();
    timer = setInterval(tick, KNAUF_INDEX_POLL_MS);
    return () => {
      cancelled = true;
      if (timer != null) {
        clearInterval(timer);
      }
    };
  }, [pendingBatchId]);

  if (pendingBatchId == null || summary == null || summary.terminal || summary.total === 0) {
    return null;
  }

  const ready = summary.counts.ready;
  const failed = summary.counts.failed;
  return (
    <div
      className="flex items-center gap-2 px-2 py-1 text-xs text-text-secondary"
      data-testid="knauf-batch-index-summary"
    >
      <Spinner className="size-3.5" aria-hidden="true" />
      <span>
        {localize('com_knauf_file_indexing_batch_summary', {
          0: String(ready),
          1: String(summary.total),
        })}
        {failed > 0 && (
          <span className="text-red-500">
            {' · '}
            {localize('com_knauf_file_indexing_batch_failed', { 0: String(failed) })}
          </span>
        )}
      </span>
    </div>
  );
}
// End [knauf]
