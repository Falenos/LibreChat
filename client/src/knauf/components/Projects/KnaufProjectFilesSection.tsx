import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react';
import * as Ariakit from '@ariakit/react';
import { DropdownPopup, SharePointIcon, useToastContext } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { EModelEndpoint, EToolResources, QueryKeys } from 'librechat-data-provider';
import type {
  TChatProjectFile,
  TChatProjectFilesResponse,
  TFile,
  TFileUpload,
} from 'librechat-data-provider';
import { Eye, FileText, Folder, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react';
import type { ExtendedFile } from '~/common';
import FilePreviewDialog from '~/components/Chat/Messages/Content/FilePreviewDialog';
import { SharePointPickerDialog } from '~/components/SharePoint';
import { useGetStartupConfig } from '~/data-provider';
import {
  useAddProjectFileMutation,
  useDeleteProjectFileMutation,
} from '~/data-provider/Projects/mutations';
import { useProjectFilesQuery } from '~/data-provider/Projects/queries';
import { useFileHandlingNoChatContext } from '~/hooks/Files/useFileHandling';
import { useSharePointFileHandlingNoChatContext } from '~/hooks/Files/useSharePointFileHandling';
import KnaufFileIndexingStatus from '~/knauf/components/Files/KnaufFileIndexingStatus';
import type { KnaufFileIndexing } from '~/knauf/common/fileIndexing';
import { postRetryFileIndex } from '~/knauf/data-provider/data-service';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type ProjectFileRow = TChatProjectFile & {
  upload?: ExtendedFile;
  uploadKey?: string;
};

const EMPTY_PROJECT_FILES: TChatProjectFile[] = [];

function toFilesPanelRow(file: TChatProjectFile | TFileUpload): TFile {
  const fallbackName = file.filename?.trim() || file.file_id;
  return {
    ...(file as TFile),
    filename: fallbackName,
    type: file.type ?? '',
    bytes: file.bytes ?? 0,
    embedded: file.embedded ?? file.status === 'ready',
    object: (file as TFile).object ?? 'file',
    filepath: (file as TFile).filepath ?? '',
    usage: (file as TFile).usage ?? 0,
  };
}

function toProjectFileRow(
  projectId: string,
  uploadKey: string,
  upload: ExtendedFile,
): ProjectFileRow {
  const failed = upload.progress < 0 || upload.indexing?.status === 'failed';
  const ready = upload.progress >= 1 && (upload.indexing?.ready ?? upload.embedded ?? false);
  let status: TChatProjectFile['status'] = 'processing';
  if (failed) {
    status = 'failed';
  } else if (ready) {
    status = 'ready';
  } else if (upload.progress < 1) {
    status = 'uploading';
  }
  return {
    projectId,
    file_id: upload.file_id,
    sourceType: 'file',
    user: '',
    status,
    filename: upload.filename ?? upload.file?.name,
    type: upload.type ?? upload.file?.type,
    bytes: upload.size,
    embedded: upload.embedded,
    indexing: upload.indexing as TChatProjectFile['indexing'],
    upload,
    uploadKey,
  };
}

function toUploadEngineFile(file: TChatProjectFile): ExtendedFile {
  return {
    file_id: file.file_id,
    filename: file.filename,
    type: file.type,
    size: file.bytes ?? 0,
    progress: 1,
    attached: true,
    embedded: file.embedded ?? file.status === 'ready',
    indexing: file.indexing as KnaufFileIndexing | undefined,
    tool_resource: EToolResources.file_search,
  };
}

export default function KnaufProjectFilesSection({ projectId }: { projectId: string }) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const retryingIndexIdsRef = useRef(new Set<string>());
  const queryClient = useQueryClient();
  const [previewFile, setPreviewFile] = useState<TChatProjectFile | null>(null);
  const [uploadEntries, setUploadEntries] = useState<Map<string, ExtendedFile>>(new Map());
  const [retryUpload, setRetryUpload] = useState<File | null>(null);
  const [retryingIndexIds, setRetryingIndexIds] = useState<Set<string>>(new Set());
  const [isDragActive, setIsDragActive] = useState(false);
  const [isPopoverActive, setIsPopoverActive] = useState(false);
  const [isSharePointDialogOpen, setIsSharePointDialogOpen] = useState(false);
  const { data: startupConfig } = useGetStartupConfig();
  const { data, isLoading } = useProjectFilesQuery(projectId);
  const addProjectFile = useAddProjectFileMutation();
  const deleteProjectFile = useDeleteProjectFileMutation();
  const files = data?.files ?? EMPTY_PROJECT_FILES;

  const onUploadSuccess = useCallback(
    async (file: TFileUpload) => {
      await addProjectFile.mutateAsync({
        projectId,
        file_id: file.file_id,
        status: file.embedded ? 'ready' : 'processing',
      });
      queryClient.setQueryData<TFile[] | undefined>([QueryKeys.files], (cachedFiles) => {
        const current = cachedFiles ?? [];
        return current.some((item) => item.file_id === file.file_id)
          ? current
          : [toFilesPanelRow(file), ...current];
      });
      queryClient.invalidateQueries([QueryKeys.files]);
    },
    [addProjectFile, projectId, queryClient],
  );

  // [knauf] KK20-248 — projects join the same validation, serialization,
  // transport retry, progress, before-unload, and SharePoint upload engine as agents.
  const fileHandlingState = useMemo(
    () => ({ files: uploadEntries, setFiles: setUploadEntries }),
    [uploadEntries],
  );
  const fileHandlingOptions = useMemo(
    () => ({
      additionalMetadata: { tool_resource: EToolResources.file_search },
      endpointOverride: EModelEndpoint.agents,
      endpointTypeOverride: EModelEndpoint.agents,
      onUploadSuccess,
    }),
    [onUploadSuccess],
  );
  const { handleFileChange, handleFiles } = useFileHandlingNoChatContext(
    fileHandlingOptions,
    fileHandlingState,
  );
  const { handleSharePointFiles, isProcessing, downloadProgress } =
    useSharePointFileHandlingNoChatContext(fileHandlingOptions, fileHandlingState);
  // End [knauf]

  useEffect(() => {
    if (files.length === 0) {
      return;
    }
    queryClient.setQueryData<TFile[] | undefined>([QueryKeys.files], (cachedFiles) => {
      const current = cachedFiles ?? [];
      const cachedIds = new Set(current.map((file) => file.file_id));
      const missingFiles = files
        .filter((file) => file.status !== 'failed' && !cachedIds.has(file.file_id))
        .map((file) => toFilesPanelRow(file));
      return missingFiles.length > 0 ? [...missingFiles, ...current] : current;
    });
  }, [files, queryClient]);

  useEffect(() => {
    const serverFileIds = new Set(files.map((file) => file.file_id));
    setUploadEntries((current) => {
      const next = new Map<string, ExtendedFile>();
      for (const [key, entry] of current) {
        if (!entry.attached && !serverFileIds.has(entry.file_id)) {
          next.set(key, entry);
        }
      }
      for (const file of files) {
        next.set(file.file_id, toUploadEngineFile(file));
      }
      return next;
    });
  }, [files]);

  useEffect(() => {
    if (retryUpload == null) {
      return;
    }
    const file = retryUpload;
    setRetryUpload(null);
    void handleFiles([file]);
  }, [handleFiles, retryUpload]);

  const visibleFiles: ProjectFileRow[] = [
    ...Array.from(uploadEntries, ([key, upload]) =>
      toProjectFileRow(projectId, key, upload),
    ).filter((upload) => !upload.upload?.attached),
    ...files,
  ];
  const displayNameFor = (file: TChatProjectFile) => file.filename?.trim() || file.file_id;

  const onUpload = (event: ChangeEvent<HTMLInputElement>) => {
    handleFileChange(event);
  };

  const onDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragActive(true);
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (!isDragActive) {
      setIsDragActive(true);
    }
  };

  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsDragActive(false);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    void handleFiles(Array.from(event.dataTransfer.files ?? []));
  };

  const openLocalPicker = () => {
    if (inputRef.current) {
      inputRef.current.value = '';
      inputRef.current.click();
    }
  };

  const handleSharePointFilesSelected = async (
    sharePointFiles: Parameters<typeof handleSharePointFiles>[0],
  ) => {
    try {
      await handleSharePointFiles(sharePointFiles);
      setIsSharePointDialogOpen(false);
    } catch (error) {
      console.error('SharePoint file processing error:', error);
    }
  };

  const retryFailedUpload = (file: ProjectFileRow) => {
    if (file.uploadKey == null || file.upload?.file == null) {
      return;
    }
    const retryFile = file.upload.file;
    setUploadEntries((current) => {
      const next = new Map(current);
      next.delete(file.uploadKey as string);
      return next;
    });
    setRetryUpload(retryFile);
  };

  const removeFailedUpload = (file: ProjectFileRow) => {
    if (file.uploadKey == null) {
      return;
    }
    setUploadEntries((current) => {
      const next = new Map(current);
      next.delete(file.uploadKey as string);
      return next;
    });
  };

  const retryIndexing = async (file: TChatProjectFile) => {
    if (retryingIndexIdsRef.current.has(file.file_id)) {
      return;
    }
    retryingIndexIdsRef.current.add(file.file_id);
    setRetryingIndexIds((current) => new Set(current).add(file.file_id));
    try {
      const response = await postRetryFileIndex(file.file_id);
      queryClient.setQueryData<TChatProjectFilesResponse>(
        [QueryKeys.projectFiles, projectId],
        (current) => ({
          files: (current?.files ?? files).map((item) =>
            item.file_id === file.file_id
              ? {
                  ...item,
                  indexing: response.indexing as TChatProjectFile['indexing'],
                  status: response.indexing.ready ? 'ready' : 'processing',
                }
              : item,
          ),
        }),
      );
      queryClient.invalidateQueries([QueryKeys.projectFiles, projectId]);
      showToast({ message: localize('com_knauf_file_indexing_retry_started'), status: 'info' });
    } catch {
      showToast({ message: localize('com_knauf_file_indexing_retry_failed'), status: 'error' });
    } finally {
      retryingIndexIdsRef.current.delete(file.file_id);
      setRetryingIndexIds((current) => {
        const next = new Set(current);
        next.delete(file.file_id);
        return next;
      });
    }
  };

  let fileListContent: ReactNode;
  if (isLoading) {
    fileListContent = <p className="text-sm text-text-secondary">{localize('com_ui_loading')}</p>;
  } else if (visibleFiles.length === 0) {
    fileListContent = (
      <p className="text-sm text-text-secondary">{localize('com_ui_no_results_found')}</p>
    );
  } else {
    fileListContent = visibleFiles.map((file) => (
      <div
        key={file.uploadKey ?? file.file_id}
        className="flex items-center gap-3 rounded-xl border border-border-light bg-surface-primary px-3 py-2"
      >
        <FileText className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-text-primary">{displayNameFor(file)}</p>
          {file.uploadKey != null ? (
            <p className="flex items-center gap-1.5 text-xs capitalize text-text-secondary">
              {file.status === 'uploading' || file.status === 'processing' ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              ) : null}
              {file.status}
            </p>
          ) : (
            <>
              <KnaufFileIndexingStatus
                indexing={file.indexing as KnaufFileIndexing | undefined}
                retrying={retryingIndexIds.has(file.file_id)}
                onRetry={() => void retryIndexing(file)}
              />
              {file.indexing == null ? (
                <p className="flex items-center gap-1.5 text-xs capitalize text-text-secondary">
                  {file.status === 'uploading' || file.status === 'processing' ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : null}
                  {file.status}
                </p>
              ) : null}
            </>
          )}
        </div>
        {file.uploadKey != null && file.status === 'failed' ? (
          <button
            type="button"
            className="rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            aria-label={localize('com_ui_retry')}
            onClick={() => retryFailedUpload(file)}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={localize('com_ui_preview')}
          disabled={file.status !== 'ready' || file.uploadKey != null}
          onClick={() => setPreviewFile(file)}
        >
          <Eye className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={localize('com_ui_delete')}
          disabled={
            deleteProjectFile.isLoading || (file.uploadKey != null && file.status !== 'failed')
          }
          onClick={() =>
            file.uploadKey != null
              ? removeFailedUpload(file)
              : deleteProjectFile.mutate({ projectId, file_id: file.file_id })
          }
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    ));
  }

  const uploadButton = (
    <Ariakit.MenuButton
      aria-label={localize('com_ui_upload')}
      className="inline-flex h-9 items-center gap-2 rounded-lg border border-border-medium px-3 text-sm font-medium text-text-primary transition-colors hover:bg-surface-hover"
    >
      <Upload className="h-4 w-4" aria-hidden="true" />
      {localize('com_ui_upload')}
    </Ariakit.MenuButton>
  );

  return (
    <section
      className={cn(
        'mt-6 rounded-2xl border bg-surface-secondary p-4 transition-colors',
        isDragActive ? 'border-blue-500 bg-surface-hover' : 'border-border-light',
      )}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-text-primary">{localize('com_ui_files')}</h2>
          <p className="mt-1 text-xs text-text-secondary">{localize('com_ui_upload_files')}</p>
        </div>
        {startupConfig?.sharePointFilePickerEnabled ? (
          <DropdownPopup
            gutter={2}
            menuId="project-file-upload-menu"
            isOpen={isPopoverActive}
            setIsOpen={setIsPopoverActive}
            trigger={uploadButton}
            items={[
              {
                label: localize('com_files_upload_local_machine'),
                onClick: openLocalPicker,
                icon: <Folder className="icon-md" />,
              },
              {
                label: localize('com_files_upload_sharepoint'),
                onClick: () => setIsSharePointDialogOpen(true),
                icon: <SharePointIcon className="icon-md" />,
              },
            ]}
            modal={true}
            unmountOnHide={true}
          />
        ) : (
          <button
            type="button"
            aria-label={localize('com_ui_upload')}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border-medium px-3 text-sm font-medium text-text-primary transition-colors hover:bg-surface-hover"
            onClick={openLocalPicker}
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            {localize('com_ui_upload')}
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          onChange={onUpload}
          multiple={true}
          tabIndex={-1}
        />
      </div>

      <div className="mt-4 space-y-2">{fileListContent}</div>

      <SharePointPickerDialog
        isOpen={isSharePointDialogOpen}
        onOpenChange={setIsSharePointDialogOpen}
        onFilesSelected={handleSharePointFilesSelected}
        isDownloading={isProcessing}
        downloadProgress={downloadProgress}
      />

      <FilePreviewDialog
        open={previewFile != null}
        onOpenChange={(open) => !open && setPreviewFile(null)}
        fileId={previewFile?.file_id}
        fileName={previewFile ? displayNameFor(previewFile) : ''}
        fileType={previewFile?.type}
        fileSize={previewFile?.bytes}
        projectId={projectId}
      />
    </section>
  );
}
