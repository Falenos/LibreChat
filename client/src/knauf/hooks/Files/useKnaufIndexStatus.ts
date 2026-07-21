/**
 * [knauf] KK20-195 WP5a — poll the indexing status of attached files while
 * any of them is non-terminal (plan §6.5: start at 5 seconds, stop when all
 * are terminal — no SSE, no WebSocket, no completion queue).
 *
 * Mounted where the chat `files` map lives (ChatForm). Every tick fetches
 * the per-file projection for PENDING files only and writes it back through
 * the same Map setter the upload flow uses; `ready` also flips `embedded`
 * so downstream consumers keyed on the legacy flag agree with the ledger.
 * Fetch failures leave the entry untouched — the next tick retries, and
 * polling always stops once nothing is pending.
 */
import { useEffect, useMemo } from 'react';
import type { ExtendedFile, FileSetter } from '~/common';
import { getFileIndexStatus } from '~/knauf/data-provider/data-service';
import { isIndexingPending } from '~/knauf/common/fileIndexing';

export const KNAUF_INDEX_POLL_MS = 5_000;
const SORT_LOCALE = 'en';

// Module-level so the poll tick doesn't nest a fetch+catch arrow inside map()
// inside tick() inside useEffect() (Sonar S2004: functions >4 levels deep).
// A failed fetch resolves to null; the tick drops nulls and retries next tick.
const fetchIndexStatus = (fileId: string) => getFileIndexStatus(fileId).catch(() => null);

export default function useKnaufIndexStatus({
  files,
  setFiles,
}: {
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
}): void {
  const pendingIds = useMemo(() => {
    const ids: string[] = [];
    for (const file of files.values()) {
      // Only poll files the server has durably accepted (upload finished).
      if (file.progress >= 1 && isIndexingPending(file.indexing)) {
        ids.push(file.file_id);
      }
    }
    // Sorted only to make `pendingKey` a stable identity for the effect's deps
    // (the ORDER is irrelevant); localeCompare satisfies Sonar S2871 vs the
    // default code-unit sort.
    return ids.sort((a, b) => a.localeCompare(b, SORT_LOCALE));
  }, [files]);
  const pendingKey = pendingIds.join(',');

  useEffect(() => {
    if (pendingIds.length === 0) {
      return;
    }
    let cancelled = false;

    const tick = async () => {
      const updates = await Promise.all(pendingIds.map(fetchIndexStatus));
      if (cancelled) {
        return;
      }
      const byId = new Map(
        updates.filter((u): u is NonNullable<typeof u> => u != null).map((u) => [u.file_id, u]),
      );
      if (byId.size === 0) {
        return;
      }
      setFiles((prev: Map<string, ExtendedFile>) => {
        const next = new Map(prev);
        for (const [key, entry] of next.entries()) {
          const update = byId.get(entry.file_id);
          if (!update) {
            continue;
          }
          next.set(key, {
            ...entry,
            indexing: update.indexing,
            embedded: update.indexing.ready ? true : entry.embedded,
          });
        }
        return next;
      });
    };

    const timer = setInterval(tick, KNAUF_INDEX_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // pendingKey is the stable identity of pendingIds — re-arm only when the
    // pending set actually changes, not on every Map identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, setFiles]);
}
// End [knauf]
