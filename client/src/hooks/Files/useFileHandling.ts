import React, { useCallback, useEffect, useRef, useMemo, useState } from 'react';
import { v4 } from 'uuid';
import debounce from 'lodash/debounce';
import { useToastContext } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import {
  QueryKeys,
  Constants,
  EToolResources,
  mergeFileConfig,
  isAssistantsEndpoint,
  getEndpointFileConfig,
  defaultAssistantsVersion,
} from 'librechat-data-provider';
import type { EModelEndpoint, TEndpointsConfig, TError } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { ExtendedFile, FileSetter } from '~/common';
import { logger, validateFiles, cachePreview, getCachedPreview, removePreviewEntry } from '~/utils';
import { useGetFileConfig, useUploadFileMutation } from '~/data-provider';
import useLocalize, { TranslationKeys } from '~/hooks/useLocalize';
import { useDelayedUploadToast } from './useDelayedUploadToast';
import { useChatContext } from '~/Providers/ChatContext';
import store, { ephemeralAgentByConvoId } from '~/store';
import useClientResize from './useClientResize';
import useUpdateFiles from './useUpdateFiles';
// [knauf] KK20-204 — shared dedup asset-key accessor (also used by the file-manager list deduper).
import { knaufAssetKey } from '~/knauf/hooks/Files/dedupeLibraryFiles';
// End [knauf]
// [knauf] KK20-195 WP5a — indexing projection type for the upload response.
import type { KnaufFileIndexing } from '~/knauf/common/fileIndexing';
// End [knauf]
// [knauf] KK20-227 — warn before an accidental refresh strands an in-flight upload.
import { useUploadBeforeUnloadGuard } from '~/knauf/hooks/Files/useUploadBeforeUnloadGuard';
// End [knauf]

type UseFileHandling = {
  fileSetter?: FileSetter;
  fileFilter?: (file: File) => boolean;
  additionalMetadata?: Record<string, string | undefined>;
  /** Overrides `endpoint` for upload routing; also used as `endpointType` fallback when `endpointTypeOverride` is not set */
  endpointOverride?: EModelEndpoint | string;
  /** Overrides `endpointType` independently from `endpointOverride` */
  endpointTypeOverride?: EModelEndpoint | string;
};

export type FileHandlingState = {
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading?: React.Dispatch<React.SetStateAction<boolean>>;
  conversation?: TConversation | null;
};

const noop = () => {};

// [knauf] KK20-227 — retry one transient document-upload transport failure.
const FAILED_UPLOAD_PROGRESS = -1;
const UPLOAD_RETRY_DELAY_MS = 1000;
const isTransientUploadError = (error: unknown) => {
  const { code, response } = (error ?? {}) as TError;
  return (
    code === 'ERR_NETWORK' ||
    code === 'ECONNABORTED' ||
    [502, 503, 504].includes(response?.status ?? 0)
  );
};
// End [knauf]

// [knauf] KK20-227 — module-level mutex serializing EVERY document upload from
// this client, not just files within one handleFiles loop. Awaiting mutateAsync
// alone only serializes one loop; a second file selection — or a different
// uploader instance (picker / drag / paste) — starts a parallel handleFiles loop
// and both mutateAsync calls run concurrently, restoring the concurrent RAG
// /embed (Azure Document Intelligence OCR) load that causes the silent OCR-less
// fallback (KK20-227). Chaining through one module-scoped promise makes every
// document upload wait for the previous to settle (success OR failure) before
// starting, regardless of how many loops / hook instances are active. Applies to
// the document (file_search) path only; images take the vision path (no OCR).
let documentUploadQueue: Promise<unknown> = Promise.resolve();
const pendingFileSlotReservations = new Map<string, number>();
function enqueueDocumentUpload<T>(task: () => Promise<T>): Promise<T> {
  const run = documentUploadQueue.then(task, task);
  // Keep the chain alive whatever this upload's outcome (never stays rejected).
  documentUploadQueue = run.then(noop, noop);
  return run;
}

/** Test-only: reset the module-level document-upload queue between tests. */
export function _resetDocumentUploadQueue(): void {
  documentUploadQueue = Promise.resolve();
  pendingFileSlotReservations.clear();
}
// End [knauf]

// [knauf] KK20-204 — collapse a file Map so each content-hash dedup asset
// appears once. The server mints a distinct file_id per upload but points
// repeat uploads of identical content at one shared knauf_asset_id; keeping the
// first entry per asset stops an identical re-attachment from showing/sending
// twice. Entries without a knauf_asset_id (non-deduped uploads, images) are left
// untouched. Returns the same Map reference when nothing changes so callers that
// pass it to a React setter don't trigger a needless re-render. Pure + exported
// for unit testing (useFileHandlingAssetDedup.knauf.spec.ts).
export function dedupeFilesByAsset(files: Map<string, ExtendedFile>): Map<string, ExtendedFile> {
  const seenAssets = new Set<string>();
  const duplicateKeys: string[] = [];
  for (const [key, file] of files) {
    const assetId = knaufAssetKey(file);
    if (assetId === undefined) {
      continue;
    }
    if (seenAssets.has(assetId)) {
      duplicateKeys.push(key);
    } else {
      seenAssets.add(assetId);
    }
  }
  if (duplicateKeys.length === 0) {
    return files;
  }
  const next = new Map(files);
  for (const key of duplicateKeys) {
    next.delete(key);
  }
  return next;
}
// End [knauf]

// [knauf] Accept available attachment slots instead of rejecting a whole multi-file selection. KK20-227.
export function limitIncomingFiles(
  fileList: File[],
  currentFileCount: number,
  fileLimit?: number,
): { accepted: File[]; rejected: number } {
  if (!fileLimit) {
    return { accepted: fileList, rejected: 0 };
  }
  const available = Math.max(fileLimit - currentFileCount, 0);
  return {
    accepted: fileList.slice(0, available),
    rejected: Math.max(fileList.length - available, 0),
  };
}
// End [knauf]

const useFileHandlingCore = (params: UseFileHandling | undefined, fileState: FileHandlingState) => {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const [errors, setErrors] = useState<string[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  // [knauf] KK20-227 — lets onError suppress cleanup only for the first retryable attempt.
  const documentUploadAttemptsRef = useRef(new Map<string, number>());
  // End [knauf]
  const { startUploadTimer, clearUploadTimer } = useDelayedUploadToast();
  const { files, setFiles, conversation } = fileState;
  const setFilesLoading = fileState.setFilesLoading ?? noop;
  const setEphemeralAgent = useSetRecoilState(
    ephemeralAgentByConvoId(conversation?.conversationId ?? Constants.NEW_CONVO),
  );
  const isTemporary = useRecoilValue(store.isTemporary);
  const setError = (error: string) => setErrors((prevErrors) => [...prevErrors, error]);
  const { addFile, replaceFile, updateFileById, deleteFileById } = useUpdateFiles(
    params?.fileSetter ?? setFiles,
  );
  const { resizeImageIfNeeded } = useClientResize();

  // [knauf] KK20-227 — block an accidental refresh while any upload is mid-flight
  // (progress < 1), matching the send-button gate in FileRow. Prevents the
  // "refresh stranded my upload → file looks done but OCR missing" path.
  const hasPendingUploads = useMemo(
    () => Array.from(files.values()).some((file) => file.progress < 1),
    [files],
  );
  useUploadBeforeUnloadGuard(hasPendingUploads);
  // End [knauf]

  const agent_id = params?.additionalMetadata?.agent_id ?? '';
  const assistant_id = params?.additionalMetadata?.assistant_id ?? '';
  const isConversationUpload = !agent_id && !assistant_id;
  const endpointOverride = params?.endpointOverride;
  const endpointTypeOverride = params?.endpointTypeOverride;
  const endpointType = useMemo(
    () => endpointTypeOverride ?? endpointOverride ?? conversation?.endpointType,
    [endpointTypeOverride, endpointOverride, conversation?.endpointType],
  );
  const endpoint = useMemo(
    () => endpointOverride ?? conversation?.endpoint ?? 'default',
    [endpointOverride, conversation?.endpoint],
  );

  const { data: fileConfig = null } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });

  const displayToast = useCallback(() => {
    if (errors.length > 1) {
      // TODO: this should not be a dynamic localize input!!
      const errorList = Array.from(new Set(errors))
        .map((e, i) => `${i > 0 ? '• ' : ''}${localize(e as TranslationKeys) || e}\n`)
        .join('');
      showToast({
        message: errorList,
        status: 'error',
        duration: 5000,
      });
    } else if (errors.length === 1) {
      // TODO: this should not be a dynamic localize input!!
      const message = localize(errors[0] as TranslationKeys) || errors[0];
      showToast({
        message,
        status: 'error',
        duration: 5000,
      });
    }

    setErrors([]);
  }, [errors, showToast, localize]);

  const debouncedDisplayToast = debounce(displayToast, 250);

  useEffect(() => {
    if (errors.length > 0) {
      debouncedDisplayToast();
    }

    return () => debouncedDisplayToast.cancel();
  }, [errors, debouncedDisplayToast]);

  const uploadFile = useUploadFileMutation(
    {
      onSuccess: (data) => {
        clearUploadTimer(data.temp_file_id);
        documentUploadAttemptsRef.current.delete(data.temp_file_id);
        console.log('upload success', data);
        if (agent_id) {
          queryClient.refetchQueries([QueryKeys.agent, agent_id]);
          return;
        }
        updateFileById(
          data.temp_file_id,
          {
            progress: 0.9,
            filepath: data.filepath,
          },
          assistant_id ? true : false,
        );

        setTimeout(() => {
          const cachedBlob = getCachedPreview(data.temp_file_id);
          if (cachedBlob && data.file_id !== data.temp_file_id) {
            cachePreview(data.file_id, cachedBlob);
            removePreviewEntry(data.temp_file_id);
          }
          updateFileById(
            data.temp_file_id,
            {
              progress: 1,
              file_id: data.file_id,
              temp_file_id: data.temp_file_id,
              filepath: data.filepath,
              type: data.type,
              height: data.height,
              width: data.width,
              filename: data.filename,
              source: data.source,
              embedded: data.embedded,
              // [knauf] KK20-204 — carry the dedup asset id (undefined for
              // non-deduped uploads) so identical re-attachments collapse below.
              knauf_asset_id: (data as { knauf_asset_id?: string }).knauf_asset_id,
              // End [knauf]
              // [knauf] KK20-195 WP5a — capture the async-indexing projection
              // from the superset upload body (202 = accepted, still indexing);
              // useKnaufIndexStatus polls it to terminal from here.
              indexing: (data as { indexing?: KnaufFileIndexing }).indexing,
              // End [knauf]
            },
            assistant_id ? true : false,
          );
          // [knauf] KK20-204 — collapse chat attachments that resolve to the same
          // dedup asset so an identical re-attachment appears (and sends, via
          // useChatFunctions `currentMsg.files = Array.from(files.values())`) once.
          // Runs through the same setter updateFileById writes through; a no-op
          // (returns the same Map ref) when there are no duplicates. The dropped
          // pointer row left on the server is a cheap orphan the KK20-203
          // convo-delete cascade reclaims. See dedupeFilesByAsset.
          (params?.fileSetter ?? setFiles)(dedupeFilesByAsset);
          // End [knauf]
        }, 300);
      },
      onError: (_error, body) => {
        const error = _error as TError | undefined;
        console.log('upload error', error);
        const file_id = body.get('file_id');
        const tool_resource = body.get('tool_resource');
        // [knauf] KK20-227 — mutateAsync invokes onError before rejecting. Keep the
        // pending chip intact while startUpload performs its one transient retry.
        const uploadAttempt = documentUploadAttemptsRef.current.get(file_id as string);
        if (uploadAttempt === 1 && isTransientUploadError(error)) {
          return;
        }
        const isDocumentUpload = uploadAttempt != null;
        documentUploadAttemptsRef.current.delete(file_id as string);
        // End [knauf]
        if (tool_resource === EToolResources.execute_code) {
          setEphemeralAgent((prev) => ({
            ...prev,
            [EToolResources.execute_code]: false,
          }));
        }
        clearUploadTimer(file_id as string);
        // [knauf] KK20-227 — retain a failed document chip so the failure is visible
        // and removable; non-document uploads keep their upstream cleanup behaviour.
        if (isDocumentUpload) {
          updateFileById(file_id as string, { progress: FAILED_UPLOAD_PROGRESS });
        } else {
          deleteFileById(file_id as string);
        }
        // End [knauf]

        let errorMessage = 'com_error_files_upload';

        if (error?.code === 'ERR_CANCELED') {
          errorMessage = 'com_error_files_upload_canceled';
        } else if (error?.response?.data?.message) {
          errorMessage = error.response.data.message;
        }
        setError(errorMessage);
      },
    },
    abortControllerRef.current?.signal,
  );

  const startUpload = async (extendedFile: ExtendedFile) => {
    const filename = extendedFile.file?.name ?? 'File';
    startUploadTimer(extendedFile.file_id, filename, extendedFile.size);

    const formData = new FormData();
    formData.append('endpoint', endpoint);
    formData.append('endpointType', endpointType ?? '');
    formData.append('file', extendedFile.file as File, encodeURIComponent(filename));
    formData.append('file_id', extendedFile.file_id);
    if (
      isConversationUpload &&
      conversation?.conversationId &&
      conversation.conversationId !== Constants.NEW_CONVO
    ) {
      formData.append('conversationId', conversation.conversationId);
    }
    if (isTemporary && isConversationUpload) {
      formData.append('isTemporary', 'true');
    }

    const width = extendedFile.width ?? 0;
    const height = extendedFile.height ?? 0;
    if (width) {
      formData.append('width', width.toString());
    }
    if (height) {
      formData.append('height', height.toString());
    }

    const metadata = params?.additionalMetadata ?? {};
    if (params?.additionalMetadata) {
      for (const [key, value = ''] of Object.entries(metadata)) {
        if (value) {
          formData.append(key, value);
        }
      }
    }

    // [knauf] KK20-195 WP5b — one client-generated batch id shared by every
    // file of a multi-file selection (plan §6.1 step 3); the server stores it
    // as knauf_upload_batch_id and the batch-status endpoint aggregates on it.
    if (extendedFile.knauf_upload_batch_id) {
      formData.append('batch_id', extendedFile.knauf_upload_batch_id);
    }
    // End [knauf]

    if (!isAssistantsEndpoint(endpointType ?? endpoint)) {
      if (!agent_id) {
        formData.append('message_file', 'true');
      }
      const tool_resource = extendedFile.tool_resource;
      if (tool_resource != null) {
        formData.append('tool_resource', tool_resource);
      }
      if (conversation?.agent_id != null && formData.get('agent_id') == null) {
        formData.append('agent_id', conversation.agent_id);
      }
      // [knauf] KK20-203 — send the originating conversationId so the server stamps
      // it on the File record and chat deletion can cascade-clean the file. Skip the
      // NEW_CONVO sentinel ('new') — a brand-new chat has no real id yet.
      if (
        conversation?.conversationId != null &&
        conversation.conversationId !== Constants.NEW_CONVO &&
        formData.get('conversationId') == null
      ) {
        formData.append('conversationId', conversation.conversationId);
      }
      // End [knauf]

      // [knauf] KK20-227 — run the document upload through the module-level
      // queue so it is serialized against every other document upload from this
      // client (this loop, a later selection, and other uploader instances), not
      // just the files in this one handleFiles call. The server runs RAG /embed
      // (Azure Document Intelligence OCR) synchronously inside the request, so
      // concurrent uploads mean concurrent DI calls — the primary trigger for DI
      // throttling (429s) and the silent OCR-less fallback (KK20-227). onError
      // already clears the file and shows a message, so swallow the rejection
      // here to keep the handleFiles loop advancing to the next file. (Images use
      // the loadImage/onload path and are unaffected — they don't hit OCR.)
      await enqueueDocumentUpload(async () => {
        const retryDocument = !extendedFile.type?.startsWith('image/');
        if (retryDocument) {
          documentUploadAttemptsRef.current.set(extendedFile.file_id, 1);
        }
        try {
          await uploadFile.mutateAsync(formData);
        } catch (error) {
          if (!retryDocument || !isTransientUploadError(error)) {
            throw error;
          }
          documentUploadAttemptsRef.current.set(extendedFile.file_id, 2);
          await new Promise((resolve) => setTimeout(resolve, UPLOAD_RETRY_DELAY_MS));
          await uploadFile.mutateAsync(formData);
        }
      }).catch(() => {});
      return;
      // End [knauf]
    }

    const convoModel = conversation?.model ?? '';
    const convoAssistantId = conversation?.assistant_id ?? '';

    if (!assistant_id) {
      formData.append('message_file', 'true');
    }

    const endpointsConfig = queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]);
    const version = endpointsConfig?.[endpoint]?.version ?? defaultAssistantsVersion[endpoint];

    if (!assistant_id && convoAssistantId) {
      formData.append('version', version);
      formData.append('model', convoModel);
      formData.append('assistant_id', convoAssistantId);
    }

    const formVersion = (formData.get('version') ?? '') as string;
    if (!formVersion) {
      formData.append('version', version);
    }

    const formModel = (formData.get('model') ?? '') as string;
    if (!formModel) {
      formData.append('model', convoModel);
    }

    uploadFile.mutate(formData);
  };

  const loadImage = (extendedFile: ExtendedFile, preview: string) => {
    const img = new Image();
    img.onload = async () => {
      extendedFile.width = img.width;
      extendedFile.height = img.height;
      extendedFile = {
        ...extendedFile,
        progress: 0.6,
      };
      replaceFile(extendedFile);

      await startUpload(extendedFile);
    };
    img.src = preview;
  };

  const handleFiles = async (_files: FileList | File[], _toolResource?: string) => {
    abortControllerRef.current = new AbortController();
    let fileList = Array.from(_files);
    const reservationKey = conversation?.conversationId ?? Constants.NEW_CONVO;
    /* Validate files */
    let filesAreValid: boolean;
    try {
      const endpointFileConfig = getEndpointFileConfig({
        endpoint,
        fileConfig,
        endpointType,
      });

      // [knauf] Keep the files that fit and tell the user exactly what was
      // accepted/rejected. validateFiles still enforces every other limit.
      // KK20-227.
      const pendingSlots = pendingFileSlotReservations.get(reservationKey) ?? 0;
      const limitedFiles = limitIncomingFiles(
        fileList,
        files.size + pendingSlots,
        endpointFileConfig.fileLimit,
      );
      fileList = limitedFiles.accepted;
      if (fileList.length === 0) {
        if (limitedFiles.rejected > 0) {
          showToast({
            message: localize('com_knauf_file_limit_partial', {
              0: '0',
              1: String(limitedFiles.rejected),
              2: String(endpointFileConfig.fileLimit),
            }),
            status: 'warning',
          });
        }
        setFilesLoading(false);
        return;
      }
      // End [knauf]

      filesAreValid = validateFiles({
        files,
        fileList,
        setError,
        fileConfig,
        endpointFileConfig,
        toolResource: _toolResource,
        // [knauf] Gate the Knauf per-category caps + legacy/unsupported messaging
        // to the allow-list endpoints (azureOpenAI/agents), matching filterFile
        // server-side. KK20-190.
        endpoint,
        // End [knauf]
      });
      if (filesAreValid && limitedFiles.rejected > 0) {
        showToast({
          message: localize('com_knauf_file_limit_partial', {
            0: String(fileList.length),
            1: String(limitedFiles.rejected),
            2: String(endpointFileConfig.fileLimit),
          }),
          status: 'warning',
        });
      }
    } catch (error) {
      console.error('file validation error', error);
      setError('com_error_files_validation');
      return;
    }
    if (!filesAreValid) {
      setFilesLoading(false);
      return;
    }

    // [knauf] KK20-195 WP5b — a multi-file selection shares ONE client batch
    // id (plan §6.1 step 3); single files stay batch-less. Drives the §6.3
    // aggregate summary; the server scopes it to the owner, never authorization.
    const knaufBatchId = fileList.length > 1 ? v4() : undefined;
    // End [knauf]

    // [knauf] KK20-227/KK20-195 — reserve accepted slots and stamp the shared batch id.
    // Picker, paste, and drag handlers can otherwise observe the same stale files.size and
    // collectively exceed the five-file cap. The reservation only spans this event turn;
    // the synchronously-added placeholders become authoritative afterwards. KK20-227.
    const reservedSlots = fileList.length;
    pendingFileSlotReservations.set(
      reservationKey,
      (pendingFileSlotReservations.get(reservationKey) ?? 0) + reservedSlots,
    );
    const queuedFiles: Array<{
      originalFile: File;
      file_id: string;
      initialPreview: string;
      initialExtendedFile: ExtendedFile;
    }> = [];
    for (const originalFile of fileList) {
      const file_id = v4();
      try {
        const initialPreview = URL.createObjectURL(originalFile);
        cachePreview(file_id, initialPreview);
        const initialExtendedFile: ExtendedFile = {
          file_id,
          file: originalFile,
          type: originalFile.type,
          preview: initialPreview,
          progress: 0.1, // Show as processing
          size: originalFile.size,
          // KK20-195 WP5b — see knaufBatchId above.
          knauf_upload_batch_id: knaufBatchId,
        };
        // End [knauf]

        // [knauf] Chat "Upload files" routes documents to File Search (RAG),
        // but images must stay on the vision path — the server rejects images
        // for the file_search tool_resource. Drop tool_resource for image
        // files so they upload as normal vision attachments. KK20-190.
        const isImageFile = originalFile.type?.startsWith('image/') ?? false;
        const effectiveToolResource =
          _toolResource === EToolResources.file_search && isImageFile ? undefined : _toolResource;
        if (effectiveToolResource != null && effectiveToolResource !== '') {
          initialExtendedFile.tool_resource = effectiveToolResource;
        }
        // End [knauf]

        // [knauf] KK20-227 — complete accepted-slot reservation bookkeeping.
        addFile(initialExtendedFile);
        queuedFiles.push({ originalFile, file_id, initialPreview, initialExtendedFile });
      } catch (error) {
        console.log('file handling error', error);
        setError('com_error_files_process');
      }
    }
    queueMicrotask(() => {
      const remaining = (pendingFileSlotReservations.get(reservationKey) ?? 0) - reservedSlots;
      if (remaining > 0) {
        pendingFileSlotReservations.set(reservationKey, remaining);
      } else {
        pendingFileSlotReservations.delete(reservationKey);
      }
    });
    // End [knauf]

    /* Process files */
    for (const { originalFile, file_id, initialPreview, initialExtendedFile } of queuedFiles) {
      try {
        const originalFileName = originalFile.name.toLowerCase();

        // Check if HEIC conversion is needed and show toast
        const isHEIC =
          originalFile.type === 'image/heic' ||
          originalFile.type === 'image/heif' ||
          /\.(heic|heif)$/.test(originalFileName);

        if (isHEIC) {
          showToast({
            message: localize('com_info_heic_converting'),
            status: 'info',
            duration: 3000,
          });
        }

        const heicProcessedFile = isHEIC
          ? await import('~/utils/heicConverter').then(({ processFileForUpload }) =>
              processFileForUpload(originalFile, 0.9, (conversionProgress) => {
                const adjustedProgress = 0.1 + conversionProgress * 0.4;
                replaceFile({
                  ...initialExtendedFile,
                  progress: adjustedProgress,
                });
              }),
            )
          : originalFile;

        let finalProcessedFile = heicProcessedFile;

        // Apply client-side resizing if available and appropriate
        if (heicProcessedFile.type.startsWith('image/')) {
          try {
            const resizeResult = await resizeImageIfNeeded(heicProcessedFile);
            finalProcessedFile = resizeResult.file;

            // Show toast notification if image was resized
            if (resizeResult.resized && resizeResult.result) {
              const { originalSize, newSize, compressionRatio } = resizeResult.result;
              const originalSizeMB = (originalSize / (1024 * 1024)).toFixed(1);
              const newSizeMB = (newSize / (1024 * 1024)).toFixed(1);
              const savedPercent = Math.round((1 - compressionRatio) * 100);

              showToast({
                message: `Image resized: ${originalSizeMB}MB → ${newSizeMB}MB (${savedPercent}% smaller)`,
                status: 'success',
                duration: 3000,
              });
            }
          } catch (resizeError) {
            console.warn('Image resize failed, using original:', resizeError);
            // Continue with HEIC processed file if resizing fails
          }
        }

        // If file was processed (HEIC converted or resized), update with new file and preview
        if (finalProcessedFile !== originalFile) {
          URL.revokeObjectURL(initialPreview); // Clean up original preview
          const newPreview = URL.createObjectURL(finalProcessedFile);
          cachePreview(file_id, newPreview);

          const updatedExtendedFile: ExtendedFile = {
            ...initialExtendedFile,
            file: finalProcessedFile,
            type: finalProcessedFile.type,
            preview: newPreview,
            progress: 0.5, // Processing complete, ready for upload
            size: finalProcessedFile.size,
          };

          replaceFile(updatedExtendedFile);

          const isImage = finalProcessedFile.type.split('/')[0] === 'image';
          if (isImage) {
            loadImage(updatedExtendedFile, newPreview);
            continue;
          }

          await startUpload(updatedExtendedFile);
        } else {
          // File wasn't processed, proceed with original
          const isImage = originalFile.type.split('/')[0] === 'image';

          // Update progress to show ready for upload
          const readyExtendedFile = {
            ...initialExtendedFile,
            progress: 0.2,
          };
          replaceFile(readyExtendedFile);

          if (isImage) {
            loadImage(readyExtendedFile, initialPreview);
            continue;
          }

          await startUpload(readyExtendedFile);
        }
      } catch (error) {
        deleteFileById(file_id);
        console.log('file handling error', error);
        if (error instanceof Error && error.message.includes('HEIC')) {
          setError('com_error_heic_conversion');
        } else {
          setError('com_error_files_process');
        }
      }
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>, _toolResource?: string) => {
    event.stopPropagation();
    if (event.target.files) {
      setFilesLoading(true);
      handleFiles(event.target.files, _toolResource);
      // reset the input
      event.target.value = '';
    }
  };

  const abortUpload = () => {
    if (abortControllerRef.current) {
      logger.log('files', 'Aborting upload');
      abortControllerRef.current.abort('User aborted upload');
      abortControllerRef.current = null;
    }
  };

  return {
    handleFileChange,
    handleFiles,
    abortUpload,
    setFiles,
    files,
  };
};

export const useFileHandlingNoChatContext = (
  params: UseFileHandling | undefined,
  fileState: FileHandlingState,
) => useFileHandlingCore(params, fileState);

const useFileHandling = (params?: UseFileHandling) => {
  const { files, setFiles, setFilesLoading, conversation } = useChatContext();

  return useFileHandlingCore(params, {
    files,
    setFiles,
    conversation,
    setFilesLoading,
  });
};

export default useFileHandling;
