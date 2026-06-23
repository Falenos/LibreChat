/**
 * [knauf] fork of upstream
 * client/src/components/SidePanel/Agents/FileSearch.tsx.
 *
 * Four intentional changes vs upstream:
 *   1. Inner "<label>" heading reading com_assistants_file_search — dropped;
 *      the enclosing KnaufSection already provides the section title.
 *   2. <FileSearchCheckbox /> — dropped; KnaufAgentConfig drives the
 *      `file_search` form field implicitly from knowledge_files presence.
 *   3. Upload button no longer gated on the file_search form field. Upstream
 *      gates on both, but the Knauf builder derives file_search from file
 *      presence, so requiring it for the first upload would be a
 *      chicken-and-egg lock.
 *   4. KK20-123 — uploads are allowed on unsaved (ephemeral) agents. Local
 *      files picked before save are queued in `knaufPendingAgentFilesAtom`
 *      (Recoil, scoped by `knaufPendingForAgentIdAtom`) and rendered
 *      alongside real knowledge files via the same `FileContainer`
 *      primitive. The primary drain happens in AgentPanel's create
 *      mutation `onSuccess`: it awaits `useDrainPendingKnaufFiles(newId)`
 *      BEFORE calling `setCurrentAgentId`, so the panel transitions from
 *      Create to Edit only after every queued upload has settled. Failed
 *      files surface in Edit mode as red retry cards; clicking re-fires
 *      this file's local drain effect (handles the retry path through
 *      upstream's `handleFiles` pipeline).
 *
 * Everything else (file row, SharePoint dropdown, endpointFileConfig.disabled
 * early-return) is preserved verbatim. When upstream FileSearch.tsx changes,
 * this file is the merge surface — diff it line-by-line.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { Folder } from 'lucide-react';
import * as Ariakit from '@ariakit/react';
import { useRecoilState } from 'recoil';
import { SharePointIcon, AttachmentIcon, DropdownPopup, useToastContext } from '@librechat/client';
import {
  EModelEndpoint,
  EToolResources,
  getEndpointFileConfig,
  mergeFileConfig,
} from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { isEphemeralAgent } from '~/common';
import { useSharePointFileHandlingNoChatContext } from '~/hooks/Files/useSharePointFileHandling';
import { useFileHandlingNoChatContext } from '~/hooks/Files/useFileHandling';
import { useLocalize, useLazyEffect } from '~/hooks';
import { SharePointPickerDialog } from '~/components/SharePoint';
import FileRow from '~/components/Chat/Input/Files/FileRow';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import { useGetFileConfig, useGetStartupConfig } from '~/data-provider';
import { dispatchAdobeAppInteraction } from '~/knauf/analytics/adobe';
import { knaufPendingAgentFilesAtom } from '~/knauf/store/pendingAgentFiles';

const FileRowWrapper = ({ children }: Readonly<{ children: ReactNode }>) => (
  <div className="flex flex-wrap gap-2">{children}</div>
);

type UploadedFileLike = { filename?: string; bytes?: number; size?: number };

/**
 * True when an uploaded ExtendedFile entry corresponds to a pending Knauf
 * file (same filename, same byte length). Some upstream code paths set
 * `bytes`, others set `size` — we accept either. Extracted to module scope
 * so the drain effect's predicate doesn't sit five callbacks deep
 * (SonarCloud typescript:S2004).
 */
function uploadedFileMatchesPending(uploaded: UploadedFileLike, pending: File): boolean {
  return (
    uploaded.filename === pending.name &&
    (uploaded.bytes === pending.size || uploaded.size === pending.size)
  );
}

function KnaufFileSearch({
  agent_id,
  files: _files,
}: Readonly<{
  agent_id: string;
  files?: [string, ExtendedFile][];
}>) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  // Read the pending-files atom directly. KnaufAgentConfig also subscribes
  // (for the clear-on-foreign-agent effect) but each component reads from
  // Recoil independently — no prop threading needed.
  const [pendingFiles, setPendingFiles] = useRecoilState(knaufPendingAgentFilesAtom);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Map<string, ExtendedFile>>(new Map());
  /**
   * KK20-123 — mirror of `files` for off-render reconciliation. The drain
   * effect's `.then()` runs after `handleFiles` has called `setFiles(...)`
   * to write the uploaded entries; we need to read the *latest* Map at that
   * moment, not the closure value captured when the effect first scheduled.
   */
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  const fileHandlingState = useMemo(() => ({ files, setFiles, conversation: null }), [files]);
  const [isPopoverActive, setIsPopoverActive] = useState(false);
  const [isSharePointDialogOpen, setIsSharePointDialogOpen] = useState(false);

  const { data: startupConfig } = useGetStartupConfig();
  // [knauf] Agent knowledge uploads always follow the AGENTS upload policy (allow-list
  // + per-category caps + 20-file / 100 MB limits), independent of the agent's model
  // provider. Upstream `useAgentFileConfig` resolves the file config from the agent's
  // PROVIDER endpoint (LibreChat #12117), which for a Knauf Azure-backed agent yields
  // the CHAT policy (5 files / 50 MB) — wrong for agent knowledge — and skips the Knauf
  // gate entirely for custom providers. Pin everything to `agents` so client validation,
  // the picker's max-selection count, and the server (endpoint=agents) all agree. KK20-190.
  const { data: fileConfig = null } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });
  const endpointFileConfig = useMemo(
    () => getEndpointFileConfig({ fileConfig, endpoint: EModelEndpoint.agents }),
    [fileConfig],
  );
  const endpointOverride = EModelEndpoint.agents;
  const endpointTypeOverride = EModelEndpoint.agents;

  const { handleFileChange, handleFiles } = useFileHandlingNoChatContext(
    {
      additionalMetadata: { agent_id, tool_resource: EToolResources.file_search },
      endpointOverride,
      endpointTypeOverride,
      fileSetter: setFiles,
    },
    fileHandlingState,
  );

  const { handleSharePointFiles, isProcessing, downloadProgress } =
    useSharePointFileHandlingNoChatContext(
      {
        additionalMetadata: { agent_id, tool_resource: EToolResources.file_search },
        endpointOverride,
        endpointTypeOverride,
        fileSetter: setFiles,
      },
      fileHandlingState,
    );

  /**
   * KK20-123 — once the agent transitions from ephemeral to saved, drain
   * any queued local files through the normal upload pipeline with the
   * new `agent_id` baked into the upload metadata. We `Array.from` the
   * Map values (the underlying `handleFiles` accepts `File[]`), then clear
   * the queue. Individual failures surface as the same toasts upstream's
   * `useFileHandling` already wires up; the user can re-pick the failed
   * file to retry. The ref guards against re-firing if the effect re-runs
   * for some other reason while uploads are in-flight. It is also read by
   * the `useLazyEffect` below to suppress the `_files`-prop re-sync while
   * a drain is in progress (see KK20-123 comment in that effect).
   */
  const inFlightUploadRef = useRef(false);

  useLazyEffect(
    () => {
      // KK20-123 — refuse to re-sync `files` from `_files` while we're
      // draining pendingFiles into the just-saved agent. Without this guard
      // the 750 ms-delayed setFiles wipes the in-flight uploads as soon as
      // `resetAgentForm()` lands the (file-less) new agent on the form,
      // briefly transiting `_files` through `[]`. The ref flips false in
      // the drain effect's `.finally()` once `handleFiles` settles; by
      // then `_files` will eventually catch up via the agent refetch and
      // a future invocation of this effect re-syncs cleanly.
      if (inFlightUploadRef.current) return;
      if (_files) {
        setFiles(new Map(_files));
      }
    },
    [_files],
    750,
  );

  /**
   * KK20-123 — drain queued pending files through the upload pipeline once
   * the agent is real. We do NOT clear `pendingFiles` up-front: each entry
   * stays around (flipped `queued → uploading`) so its `File` object
   * survives in case the upload fails and we need to retry. After
   * `handleFiles` settles we reconcile against the latest `files` Map:
   * pending entries whose (name, size) match an uploaded entry are
   * removed; anything still uploading flips to `error` and the user gets a
   * toast inviting them to click the failed card to retry.
   */
  useEffect(() => {
    if (!agent_id || isEphemeralAgent(agent_id)) return;
    if (inFlightUploadRef.current) return;

    const queuedEntries = Array.from(pendingFiles.entries()).filter(
      ([, entry]) => entry.status === 'queued',
    );
    if (queuedEntries.length === 0) return;

    inFlightUploadRef.current = true;

    setPendingFiles((prev) => {
      const next = new Map(prev);
      for (const [tempId] of queuedEntries) {
        const existing = next.get(tempId);
        if (existing) next.set(tempId, { ...existing, status: 'uploading' });
      }
      return next;
    });

    const queuedFiles = queuedEntries.map(([, entry]) => entry.file);

    Promise.resolve(handleFiles(queuedFiles))
      .then(() => {
        setPendingFiles((prev) => {
          const next = new Map(prev);
          for (const [tempId, entry] of prev) {
            if (entry.status !== 'uploading') continue;
            let matched = false;
            for (const f of filesRef.current.values()) {
              if (uploadedFileMatchesPending(f as UploadedFileLike, entry.file)) {
                matched = true;
                break;
              }
            }
            if (matched) {
              next.delete(tempId);
            } else {
              next.set(tempId, { ...entry, status: 'error' });
              showToast({
                message: localize('com_knauf_pending_upload_failed', { 0: entry.file.name }),
                status: 'error',
              });
            }
          }
          return next;
        });
      })
      .finally(() => {
        inFlightUploadRef.current = false;
      });
  }, [agent_id, pendingFiles, setPendingFiles, handleFiles, showToast, localize]);

  const dispatchAgentKnowledgeUploadInteraction = useCallback(() => {
    dispatchAdobeAppInteraction({
      action: 'upload_agent_knowledge_files',
      component: 'agent_builder',
      eventSpecification: 'upload_agent_knowledge_files',
      pageSection: 'agent_builder',
    });
  }, []);

  const isUploadDisabled = endpointFileConfig?.disabled ?? false;
  if (isUploadDisabled) {
    return null;
  }

  const ephemeral = isEphemeralAgent(agent_id);
  const sharePointEnabled = startupConfig?.sharePointFilePickerEnabled;

  /**
   * Local-file pick: on ephemeral, queue the File objects in
   * `pendingFiles` and let the post-save effect upload them. On a saved
   * agent, fall straight through to upstream's `handleFileChange`.
   */
  const onLocalFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    if (!ephemeral) {
      if (picked.length > 0) {
        dispatchAgentKnowledgeUploadInteraction();
      }
      handleFileChange(event);
      return;
    }
    event.target.value = '';
    if (picked.length === 0) return;
    dispatchAgentKnowledgeUploadInteraction();
    setPendingFiles((prev) => {
      const next = new Map(prev);
      for (const file of picked) {
        // Pending entries are keyed by an opaque temp id (filename:size:lastModified)
        // — collision-stable enough that re-picking the same file replaces
        // the queued entry (including any prior `error` state) rather than
        // duplicating it.
        const tempId = `pending:${file.name}:${file.size}:${file.lastModified}`;
        next.set(tempId, { file, status: 'queued' });
      }
      return next;
    });
  };

  const handleSharePointFilesSelected = async (sharePointFiles: any[]) => {
    try {
      await handleSharePointFiles(sharePointFiles);
      if (sharePointFiles.length > 0) {
        dispatchAgentKnowledgeUploadInteraction();
      }
      setIsSharePointDialogOpen(false);
    } catch (error) {
      console.error('SharePoint file processing error:', error);
    }
  };

  const handleButtonClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleSharePointDropdownClick = () => {
    setIsSharePointDialogOpen(true);
  };

  const dropdownItems = [
    {
      label: localize('com_files_upload_local_machine'),
      onClick: handleButtonClick,
      icon: <Folder className="icon-md" />,
    },
    {
      label: localize('com_files_upload_sharepoint'),
      onClick: handleSharePointDropdownClick,
      icon: <SharePointIcon className="icon-md" />,
    },
  ];

  const menuTrigger = (
    <Ariakit.MenuButton className="btn btn-neutral border-token-border-light relative h-9 w-full rounded-lg text-sm font-medium">
      <div className="flex w-full items-center justify-center gap-1">
        <AttachmentIcon className="text-token-text-primary h-4 w-4" />
        {localize('com_ui_upload_file_search')}
      </div>
    </Ariakit.MenuButton>
  );

  const removePending = (tempId: string) => {
    setPendingFiles((prev) => {
      if (!prev.has(tempId)) return prev;
      const next = new Map(prev);
      next.delete(tempId);
      return next;
    });
  };

  /**
   * KK20-123 — flip a failed pending entry back to `queued`. The drain
   * effect re-fires on the next render because `pendingFiles` changes and
   * the queued-filter has a fresh entry to process. Plain function (not
   * useCallback) because it sits after an early return and the closure
   * isn't passed to a memoized child — wrapping it in a hook would
   * violate the rules-of-hooks order.
   */
  const retryPending = (tempId: string) => {
    setPendingFiles((prev) => {
      const entry = prev.get(tempId);
      if (entry?.status !== 'error') return prev;
      const next = new Map(prev);
      next.set(tempId, { ...entry, status: 'queued' });
      return next;
    });
  };

  const retryLabel = localize('com_knauf_retry_upload');

  return (
    <div className="w-full">
      <div className="flex flex-col gap-3">
        <FileRow
          files={files}
          setFiles={setFiles}
          agent_id={agent_id}
          tool_resource={EToolResources.file_search}
          Wrapper={FileRowWrapper}
        />
        {pendingFiles.size > 0 ? (
          <FileRowWrapper>
            {Array.from(pendingFiles.entries()).map(([tempId, entry]) => {
              const isError = entry.status === 'error';
              const isUploading = entry.status === 'uploading';
              // Reuse upstream's existing in-icon Spinner via FilePreview's
              // `progress < 1` branch (see FilePreview.tsx:24-30). Passing
              // `progress: 0.5` while uploading mirrors how the real
              // ExtendedFile entries render mid-upload — same visual
              // language, no custom overlay needed.
              return (
                <FileContainer
                  key={tempId}
                  file={{
                    filename: entry.file.name,
                    type: entry.file.type,
                    progress: isUploading ? 0.5 : 1,
                  }}
                  containerClassName={isError ? 'ring-1 ring-red-500/60 rounded-2xl' : undefined}
                  buttonClassName={isError ? 'cursor-pointer' : undefined}
                  onClick={
                    isError
                      ? () => {
                          retryPending(tempId);
                          showToast({ message: retryLabel, status: 'info' });
                        }
                      : undefined
                  }
                  onDelete={isUploading ? undefined : () => removePending(tempId)}
                />
              );
            })}
          </FileRowWrapper>
        ) : null}
        <div>
          {sharePointEnabled ? (
            <DropdownPopup
              gutter={2}
              menuId="file-search-upload-menu"
              isOpen={isPopoverActive}
              setIsOpen={setIsPopoverActive}
              trigger={menuTrigger}
              items={dropdownItems}
              modal={true}
              unmountOnHide={true}
            />
          ) : (
            <button
              type="button"
              className="btn btn-neutral border-token-border-light relative h-9 w-full rounded-lg text-sm font-medium"
              onClick={handleButtonClick}
            >
              <div className="flex w-full items-center justify-center gap-1">
                <AttachmentIcon className="text-token-text-primary h-4 w-4" />
                {localize('com_ui_upload_file_search')}
              </div>
            </button>
          )}
          <input
            multiple={true}
            type="file"
            style={{ display: 'none' }}
            tabIndex={-1}
            ref={fileInputRef}
            onChange={onLocalFileInputChange}
          />
        </div>
      </div>

      <SharePointPickerDialog
        isOpen={isSharePointDialogOpen}
        onOpenChange={setIsSharePointDialogOpen}
        onFilesSelected={handleSharePointFilesSelected}
        isDownloading={isProcessing}
        downloadProgress={downloadProgress}
      />
    </div>
  );
}

const MemoizedKnaufFileSearch = memo(KnaufFileSearch);
MemoizedKnaufFileSearch.displayName = 'KnaufFileSearch';

export default MemoizedKnaufFileSearch;
