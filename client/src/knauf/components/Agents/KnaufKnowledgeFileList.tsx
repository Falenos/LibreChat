/**
 * [knauf] KK20-188 — Condensed, searchable knowledge-file list for the agent
 * builder's "Data Knowledge" section.
 *
 * Replaces the upstream <FileRow> rendering (two-line <FileContainer> cards:
 * w-56, a 40px icon and a redundant type label such as "Document") for the
 * agent knowledge list only. This is a net-new Knauf component (Tier 5) — it
 * does NOT modify any upstream file. It reuses the upstream primitives that do
 * the real work, so behaviour stays identical to FileRow where it matters:
 *   - getFileType()          → type-aware icon colour + white glyph (utils/files.ts)
 *   - useFileDeletion()      → the exact 1s-debounced batch delete FileRow uses
 *   - useDeleteFilesMutation(), useDebounce()
 *
 * Intentional divergences from upstream FileRow/FileContainer (KK20-188):
 *   1. One compact single-line row per file (~30px) instead of ~64px cards.
 *   2. A name search box + sort control, shown once the list is worth filtering
 *      (>= SEARCH_THRESHOLD files) — upstream has no search at all.
 *   3. The type label ("Document"/"Spreadsheet"/…) is dropped: the icon already
 *      carries the type and the byte size disambiguates near-identical copies.
 *   4. Saved files and pending (queued/uploading/error) uploads render in ONE
 *      list with the same row so search covers both; KnaufFileSearch previously
 *      rendered pending uploads as a separate <FileContainer> card strip.
 */
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import * as Ariakit from '@ariakit/react';
import { Search, X, Trash2, RefreshCw, ChevronDown, Check } from 'lucide-react';
import { DropdownPopup, Input, Spinner, useToastContext } from '@librechat/client';
import type { EToolResources } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { getFileType, cn } from '~/utils';
import { useDeleteFilesMutation } from '~/data-provider';
import { useFileDeletion } from '~/hooks/Files';
import { useDebounce, useLocalize } from '~/hooks';

type Localize = ReturnType<typeof useLocalize>;
type PendingStatus = 'queued' | 'uploading' | 'error';
type PendingEntry = { file: File; status: PendingStatus };
type SortKey = 'added' | 'name' | 'size';

/** Only surface search + sort once the list is genuinely worth filtering. */
const SEARCH_THRESHOLD = 5;
/** Cross-user-consistent name sort — Karl's dominant user base is Knauf-DE. */
const SORT_LOCALE = 'de';

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];
/**
 * utils/files.ts `formatBytes` returns a *unitless* number (Table/Columns.tsx
 * rolls its own MB math for the same reason), so we format with the unit here.
 */
function formatFileSize(bytes?: number): string {
  if (bytes == null || bytes <= 0) {
    return '';
  }
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), SIZE_UNITS.length - 1);
  const value = bytes / Math.pow(1024, i);
  const rounded = value >= 10 || i === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${SIZE_UNITS[i]}`;
}

const ACTION_CLASS =
  'flex size-6 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-hover-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Shared presentational shell: small type-aware icon (or a spinner while
 * uploading) + truncated filename + a caller-supplied right slot. Plain
 * function (re-renders only with its memo'd parent row).
 */
function FileRowShell({
  filename,
  type,
  uploading = false,
  error = false,
  children,
}: Readonly<{
  filename: string;
  type?: string;
  uploading?: boolean;
  error?: boolean;
  children?: ReactNode;
}>) {
  const { fill, paths: Paths } = getFileType(type);
  return (
    <div
      className={cn(
        'group flex items-center gap-2.5 rounded-lg px-2 py-1 transition-colors',
        error ? 'bg-red-500/5 hover:bg-red-500/10' : 'hover:bg-surface-hover',
      )}
      title={filename}
    >
      {uploading ? (
        <span className="flex size-[22px] shrink-0 items-center justify-center">
          <Spinner className="size-4 text-text-secondary" />
        </span>
      ) : (
        <svg viewBox="0 0 36 36" fill="none" className="size-[22px] shrink-0" aria-hidden="true">
          <rect width="36" height="36" rx="8" fill={fill} />
          <Paths />
        </svg>
      )}
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-sm',
          error ? 'text-red-500' : 'text-text-primary',
        )}
      >
        {filename}
      </span>
      {children}
    </div>
  );
}

const SavedFileRow = memo(function SavedFileRow({
  file,
  localize,
  onDelete,
}: Readonly<{
  file: ExtendedFile;
  localize: Localize;
  onDelete: (file: ExtendedFile) => void;
}>) {
  const handleDelete = useCallback(() => onDelete(file), [file, onDelete]);
  return (
    <FileRowShell filename={file.filename ?? ''} type={file.type}>
      {typeof file.size === 'number' && (
        <span className="shrink-0 text-xs tabular-nums text-text-secondary">
          {formatFileSize(file.size)}
        </span>
      )}
      <button
        type="button"
        onClick={handleDelete}
        aria-label={localize('com_ui_attach_remove')}
        className={cn(
          ACTION_CLASS,
          'opacity-0 hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100',
        )}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </button>
    </FileRowShell>
  );
});

const PendingFileRow = memo(function PendingFileRow({
  tempId,
  entry,
  localize,
  onRetry,
  onRemove,
}: Readonly<{
  tempId: string;
  entry: PendingEntry;
  localize: Localize;
  onRetry: (tempId: string) => void;
  onRemove: (tempId: string) => void;
}>) {
  const handleRetry = useCallback(() => onRetry(tempId), [tempId, onRetry]);
  const handleRemove = useCallback(() => onRemove(tempId), [tempId, onRemove]);
  const { file, status } = entry;

  if (status === 'uploading') {
    return <FileRowShell filename={file.name} type={file.type} uploading />;
  }

  if (status === 'error') {
    return (
      <FileRowShell filename={file.name} type={file.type} error>
        <button
          type="button"
          onClick={handleRetry}
          aria-label={localize('com_knauf_knowledge_retry')}
          className={cn(ACTION_CLASS, 'hover:text-text-primary')}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={handleRemove}
          aria-label={localize('com_ui_attach_remove')}
          className={cn(ACTION_CLASS, 'hover:text-red-500')}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </FileRowShell>
    );
  }

  // 'queued' — picked on an ephemeral agent, not yet uploading; removable.
  return (
    <FileRowShell filename={file.name} type={file.type}>
      {file.size > 0 && (
        <span className="shrink-0 text-xs tabular-nums text-text-secondary">
          {formatFileSize(file.size)}
        </span>
      )}
      <button
        type="button"
        onClick={handleRemove}
        aria-label={localize('com_ui_attach_remove')}
        className={cn(
          ACTION_CLASS,
          'opacity-0 hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100',
        )}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </FileRowShell>
  );
});

function KnaufKnowledgeFileList({
  files,
  setFiles,
  agent_id,
  tool_resource,
  pendingFiles,
  onRemovePending,
  onRetryPending,
}: Readonly<{
  files: Map<string, ExtendedFile>;
  setFiles: Dispatch<SetStateAction<Map<string, ExtendedFile>>>;
  agent_id: string;
  tool_resource?: EToolResources;
  pendingFiles: Map<string, PendingEntry>;
  onRemovePending: (tempId: string) => void;
  onRetryPending: (tempId: string) => void;
}>) {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  const [rawQuery, setRawQuery] = useState('');
  const query = useDebounce(rawQuery, 250);
  const [sort, setSort] = useState<SortKey>('added');
  const [sortOpen, setSortOpen] = useState(false);

  const { mutateAsync } = useDeleteFilesMutation();
  const { deleteFile } = useFileDeletion({ mutateAsync, agent_id, tool_resource });

  // Stable refs for closures that are recreated upstream every render (the
  // useFileDeletion mutator + KnaufFileSearch's plain remove/retry functions),
  // so the memo'd rows don't re-render on every keystroke.
  const deleteFileRef = useRef(deleteFile);
  const removePendingRef = useRef(onRemovePending);
  const retryPendingRef = useRef(onRetryPending);
  useEffect(() => {
    deleteFileRef.current = deleteFile;
    removePendingRef.current = onRemovePending;
    retryPendingRef.current = onRetryPending;
  });

  const handleDeleteSaved = useCallback(
    (file: ExtendedFile) => {
      if ((file.progress ?? 1) >= 1) {
        showToast({ message: localize('com_ui_deleting_file'), status: 'info' });
      }
      deleteFileRef.current({ file, setFiles });
    },
    [showToast, localize, setFiles],
  );
  const handleRemovePending = useCallback((tempId: string) => removePendingRef.current(tempId), []);
  const handleRetryPending = useCallback(
    (tempId: string) => {
      retryPendingRef.current(tempId);
      showToast({ message: localize('com_knauf_retry_upload'), status: 'info' });
    },
    [showToast, localize],
  );

  // Dedup saved files by file_id (mirrors FileRow.tsx's reduce).
  const seen = new Set<string>();
  const savedUnique: ExtendedFile[] = [];
  for (const file of files.values()) {
    if (!seen.has(file.file_id)) {
      seen.add(file.file_id);
      savedUnique.push(file);
    }
  }
  const pendingEntries = Array.from(pendingFiles.entries());
  const totalCount = savedUnique.length + pendingEntries.length;

  const q = query.trim().toLowerCase();
  const nameMatches = (name: string) => q === '' || name.toLowerCase().includes(q);

  const savedFiltered = savedUnique.filter((file) => nameMatches(file.filename ?? ''));
  let savedSorted = savedFiltered;
  if (sort === 'name') {
    savedSorted = [...savedFiltered].sort((a, b) =>
      (a.filename ?? '').localeCompare(b.filename ?? '', SORT_LOCALE),
    );
  } else if (sort === 'size') {
    savedSorted = [...savedFiltered].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  }
  const pendingFiltered = pendingEntries.filter(([, entry]) => nameMatches(entry.file.name));

  const visibleCount = savedSorted.length + pendingFiltered.length;

  // Truly empty (no files at all): render nothing — KnaufFileSearch still shows
  // its upload button below. Any hooks must precede this early return.
  if (totalCount === 0) {
    return null;
  }

  const sortLabelFor = (key: SortKey): string => {
    if (key === 'name') {
      return localize('com_ui_name');
    }
    if (key === 'size') {
      return localize('com_ui_size');
    }
    return localize('com_knauf_knowledge_sort_added');
  };

  const sortItems = (['added', 'name', 'size'] as SortKey[]).map((key) => ({
    label: sortLabelFor(key),
    onClick: () => setSort(key),
    icon: <Check className={cn('size-4', sort === key ? 'opacity-100' : 'opacity-0')} />,
  }));

  const sortTrigger = (
    <Ariakit.MenuButton
      aria-label={localize('com_knauf_knowledge_sort_by')}
      className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-border-light px-2.5 text-sm text-text-secondary transition-colors hover:bg-surface-hover"
    >
      {sortLabelFor(sort)}
      <ChevronDown className="size-4" aria-hidden="true" />
    </Ariakit.MenuButton>
  );

  return (
    <div className="flex flex-col gap-2">
      {totalCount >= SEARCH_THRESHOLD && (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
              aria-hidden="true"
            />
            <Input
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              placeholder={localize('com_knauf_knowledge_search_placeholder')}
              aria-label={localize('com_knauf_knowledge_search_placeholder')}
              autoComplete="off"
              spellCheck={false}
              className="h-9 border-border-light bg-surface-primary pl-8 pr-8 text-sm"
            />
            {rawQuery !== '' && (
              <button
                type="button"
                onClick={() => setRawQuery('')}
                aria-label={localize('com_ui_clear_search')}
                className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            )}
          </div>
          <DropdownPopup
            menuId="knauf-knowledge-sort"
            isOpen={sortOpen}
            setIsOpen={setSortOpen}
            trigger={sortTrigger}
            items={sortItems}
            gutter={4}
          />
        </div>
      )}

      {visibleCount === 0 ? (
        <div className="px-2 py-6 text-center text-sm text-text-secondary">
          {localize('com_knauf_knowledge_no_results', { 0: query.trim() })}
        </div>
      ) : (
        <div className="-mx-1 max-h-[288px] overflow-y-auto px-1">
          {pendingFiltered.map(([tempId, entry]) => (
            <PendingFileRow
              key={tempId}
              tempId={tempId}
              entry={entry}
              localize={localize}
              onRetry={handleRetryPending}
              onRemove={handleRemovePending}
            />
          ))}
          {savedSorted.map((file) => (
            <SavedFileRow
              key={file.file_id}
              file={file}
              localize={localize}
              onDelete={handleDeleteSaved}
            />
          ))}
        </div>
      )}

      {q !== '' && visibleCount > 0 && (
        <div className="px-1 text-xs text-text-secondary">
          {localize('com_knauf_knowledge_match_count', { 0: visibleCount, 1: totalCount })}
        </div>
      )}
    </div>
  );
}

const MemoizedKnaufKnowledgeFileList = memo(KnaufKnowledgeFileList);
MemoizedKnaufKnowledgeFileList.displayName = 'KnaufKnowledgeFileList';

export default MemoizedKnaufKnowledgeFileList;
