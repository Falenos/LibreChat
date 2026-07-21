/**
 * [knauf] KK20-195 WP5b — inline indexing state for one saved file row
 * (plan §6.5: a failed agent knowledge file remains visible with retry after
 * reload; pending files show their real server state instead of flashing).
 *
 *   pending (queued/processing/uploading) → spinner + "Indexing…"
 *   failed                                → red label + retry (when the
 *                                           server marked it retryable)
 *   ready / no projection (legacy)        → renders nothing
 */
import { memo } from 'react';
import { RefreshCw } from 'lucide-react';
import { Spinner } from '@librechat/client';
import { isIndexingPending, type KnaufFileIndexing } from '~/knauf/common/fileIndexing';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const ACTION_CLASS =
  'flex size-6 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-hover-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const KnaufFileIndexingStatus = memo(function KnaufFileIndexingStatus({
  indexing,
  retrying = false,
  onRetry,
}: Readonly<{
  indexing?: KnaufFileIndexing;
  retrying?: boolean;
  onRetry?: () => void;
}>) {
  const localize = useLocalize();

  if (isIndexingPending(indexing)) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-secondary">
        <Spinner className="size-3.5" aria-hidden="true" />
        {localize('com_knauf_file_indexing_pending')}
      </span>
    );
  }

  if (indexing?.status === 'failed') {
    return (
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="text-xs text-red-500">{localize('com_knauf_file_indexing_failed')}</span>
        {indexing.retryable && onRetry != null && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            aria-label={localize('com_knauf_file_indexing_retry')}
            className={cn(ACTION_CLASS, 'hover:text-text-primary')}
          >
            {retrying ? (
              <Spinner className="size-4" aria-hidden="true" />
            ) : (
              <RefreshCw className="size-4" aria-hidden="true" />
            )}
          </button>
        )}
      </span>
    );
  }

  return null;
});

export default KnaufFileIndexingStatus;
// End [knauf]
