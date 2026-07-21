/**
 * [knauf] KK20-195 — chat attachment indexing state + idempotent manual retry.
 * The retry response is written into the existing chat file map so the standard
 * polling hook resumes immediately from the returned queued projection.
 */
import { useCallback, useRef, useState } from 'react';
import { useToastContext } from '@librechat/client';
import type { ExtendedFile, FileSetter } from '~/common';
import { useLocalize } from '~/hooks';
import { postRetryFileIndex } from '~/knauf/data-provider/data-service';
import KnaufFileIndexingStatus from './KnaufFileIndexingStatus';

export default function KnaufChatFileIndexingStatus({
  file,
  setFiles,
}: Readonly<{
  file: ExtendedFile;
  setFiles: FileSetter;
}>) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);

  const handleRetry = useCallback(async () => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    try {
      const response = await postRetryFileIndex(file.file_id);
      setFiles((prev) => {
        const next = new Map(prev);
        for (const [key, entry] of next) {
          if (entry.file_id === response.file_id) {
            next.set(key, { ...entry, indexing: response.indexing });
          }
        }
        return next;
      });
      showToast({ message: localize('com_knauf_file_indexing_retry_started'), status: 'info' });
    } catch {
      showToast({ message: localize('com_knauf_file_indexing_retry_failed'), status: 'error' });
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  }, [file.file_id, localize, setFiles, showToast]);

  if (file.indexing == null || file.indexing.ready) return null;

  return (
    <div className="mt-1 px-1">
      <KnaufFileIndexingStatus indexing={file.indexing} retrying={retrying} onRetry={handleRetry} />
    </div>
  );
}
// End [knauf]
