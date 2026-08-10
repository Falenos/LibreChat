import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EModelEndpoint, EToolResources, QueryKeys } from 'librechat-data-provider';
import type { TChatProjectFile, TFile, TFileUpload } from 'librechat-data-provider';
import { Eye, FileText, Loader2, Trash2, Upload } from 'lucide-react';
import { useUploadFileMutation } from '~/data-provider';
import FilePreviewDialog from '~/components/Chat/Messages/Content/FilePreviewDialog';
import {
  useAddProjectFileMutation,
  useDeleteProjectFileMutation,
} from '~/data-provider/Projects/mutations';
import { useProjectFilesQuery } from '~/data-provider/Projects/queries';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

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

export default function KnaufProjectFilesSection({ projectId }: { projectId: string }) {
  const localize = useLocalize();
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<TChatProjectFile | null>(null);
  const [pendingUploads, setPendingUploads] = useState<TChatProjectFile[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const { data, isLoading } = useProjectFilesQuery(projectId);
  const addProjectFile = useAddProjectFileMutation();
  const deleteProjectFile = useDeleteProjectFileMutation();
  const resetUploadInput = () => {
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };
  const uploadFile = useUploadFileMutation({
    onSuccess: async (file, formData) => {
      const tempFileId = String(formData.get('file_id') ?? '');
      setPendingUploads((pending) =>
        pending.map((item) =>
          item.file_id === tempFileId
            ? {
                ...item,
                file_id: file.file_id,
                status: file.embedded ? 'ready' : 'processing',
              }
            : item,
        ),
      );
      try {
        await addProjectFile.mutateAsync({
          projectId,
          file_id: file.file_id,
          status: file.embedded ? 'ready' : 'processing',
        });
        // [knauf] KK20-248 — project uploads are also library files; keep the
        // left-rail Files panel cache populated even if project attach/refetch wins
        // the race against the upload mutation's cache write.
        queryClient.setQueryData<TFile[] | undefined>([QueryKeys.files], (files) => {
          const current = files ?? [];
          return current.some((item) => item.file_id === file.file_id)
            ? current
            : [toFilesPanelRow(file), ...current];
        });
        queryClient.invalidateQueries([QueryKeys.files]);
        resetUploadInput();
      } catch (_error) {
        setError(localize('com_ui_upload_error'));
        setPendingUploads((pending) => pending.filter((item) => item.file_id !== file.file_id));
        resetUploadInput();
      }
    },
    onError: (_error, formData) => {
      const tempFileId = String(formData.get('file_id') ?? '');
      setError(localize('com_ui_upload_error'));
      setPendingUploads((pending) => pending.filter((item) => item.file_id !== tempFileId));
      resetUploadInput();
    },
  });

  const isBusy = uploadFile.isLoading || addProjectFile.isLoading;
  const files = data?.files ?? [];

  useEffect(() => {
    if (files.length === 0) {
      return;
    }
    // [knauf] KK20-248 — hydrate the library cache from project files as well,
    // so files attached before this view mounted also appear in the left rail.
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
    if (pendingUploads.length === 0) {
      return;
    }
    setPendingUploads((pending) =>
      pending.filter((item) => !files.some((file) => file.file_id === item.file_id)),
    );
  }, [files, pendingUploads.length]);

  const pendingVisibleFiles = pendingUploads.filter(
    (pendingFile) => !files.some((file) => file.file_id === pendingFile.file_id),
  );
  const visibleFiles = [...pendingVisibleFiles, ...files];
  const displayNameFor = (file: TChatProjectFile) => file.filename?.trim() || file.file_id;

  const uploadFiles = (selectedFiles: File[]) => {
    if (selectedFiles.length === 0 || isBusy) {
      return;
    }
    setError(null);
    const uploads = selectedFiles.map((file) => {
      const fileId = crypto.randomUUID();
      const pendingFile: TChatProjectFile = {
        projectId,
        file_id: fileId,
        sourceType: 'file',
        user: '',
        status: 'uploading',
        filename: file.name,
        type: file.type,
        bytes: file.size,
      };
      const formData = new FormData();
      formData.append('file', file);
      formData.append('file_id', fileId);
      formData.append('endpoint', EModelEndpoint.agents);
      formData.append('endpointType', EModelEndpoint.agents);
      formData.append('tool_resource', EToolResources.file_search);
      formData.append('message_file', 'true');
      return { pendingFile, formData };
    });
    setPendingUploads((pending) => [...uploads.map((upload) => upload.pendingFile), ...pending]);
    uploads.forEach((upload) => uploadFile.mutate(upload.formData));
  };

  const onUpload = (event: ChangeEvent<HTMLInputElement>) => {
    uploadFiles(Array.from(event.target.files ?? []));
  };

  const onDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (!isBusy) {
      setIsDragActive(true);
    }
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (!isBusy && !isDragActive) {
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
    if (isBusy) {
      return;
    }
    uploadFiles(Array.from(event.dataTransfer.files ?? []));
  };

  return (
    <section
      className={cn(
        'mt-6 rounded-2xl border bg-surface-secondary p-4 transition-colors',
        isDragActive
          ? 'border-blue-500 bg-surface-hover'
          : 'border-border-light',
      )}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-text-primary">{localize('com_ui_files')}</h2>
          <p className="mt-1 text-xs text-text-secondary">
            {localize('com_ui_upload_files')}
          </p>
        </div>
        <label
          className={cn(
            'inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border-medium px-3 text-sm font-medium text-text-primary transition-colors hover:bg-surface-hover',
            isBusy && 'pointer-events-none opacity-60',
          )}
        >
          <Upload className="h-4 w-4" aria-hidden="true" />
          {localize('com_ui_upload')}
          <input
            ref={inputRef}
            type="file"
            className="sr-only"
            onChange={onUpload}
            disabled={isBusy}
            multiple
          />
        </label>
      </div>

      {error ? <p className="mt-3 text-xs text-red-500">{error}</p> : null}

      <div className="mt-4 space-y-2">
        {isLoading ? (
          <p className="text-sm text-text-secondary">{localize('com_ui_loading')}</p>
        ) : visibleFiles.length === 0 ? (
          <p className="text-sm text-text-secondary">{localize('com_ui_no_results_found')}</p>
        ) : (
          visibleFiles.map((file) => (
            <div
              key={file.file_id}
              className="flex items-center gap-3 rounded-xl border border-border-light bg-surface-primary px-3 py-2"
            >
              <FileText className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text-primary">{displayNameFor(file)}</p>
                <p className="flex items-center gap-1.5 text-xs capitalize text-text-secondary">
                  {file.status === 'uploading' || file.status === 'processing' ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : null}
                  {file.status}
                </p>
              </div>
              <button
                type="button"
                className="rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={localize('com_ui_preview')}
                disabled={file.status !== 'ready'}
                onClick={() => setPreviewFile(file)}
              >
                <Eye className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                aria-label={localize('com_ui_delete')}
                disabled={deleteProjectFile.isLoading}
                onClick={() => deleteProjectFile.mutate({ projectId, file_id: file.file_id })}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          ))
        )}
      </div>

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
