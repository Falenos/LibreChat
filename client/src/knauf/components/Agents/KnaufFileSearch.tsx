/**
 * [knauf] Tier 5 fork of upstream
 * client/src/components/SidePanel/Agents/FileSearch.tsx.
 *
 * Three intentional changes vs upstream:
 *   1. Inner "<label>" heading reading com_assistants_file_search — dropped;
 *      the enclosing KnaufSection already provides the section title.
 *   2. <FileSearchCheckbox /> — dropped; KnaufAgentConfig drives the
 *      `file_search` form field implicitly from knowledge_files presence.
 *   3. Upload button no longer gated on the file_search form field, only
 *      on isEphemeralAgent. Upstream gates on both, but the Knauf builder
 *      derives file_search from file presence, so requiring it for the
 *      first upload would be a chicken-and-egg lock.
 *
 * Everything else (file row, SharePoint dropdown, endpointFileConfig.disabled
 * early-return) is preserved verbatim. When upstream FileSearch.tsx changes,
 * this file is the merge surface — diff it line-by-line.
 */
import { memo, useMemo, useRef, useState } from 'react';
import { Folder } from 'lucide-react';
import * as Ariakit from '@ariakit/react';
import { SharePointIcon, AttachmentIcon, DropdownPopup } from '@librechat/client';
import { EModelEndpoint, EToolResources } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { useSharePointFileHandlingNoChatContext } from '~/hooks/Files/useSharePointFileHandling';
import { useFileHandlingNoChatContext } from '~/hooks/Files/useFileHandling';
import { useAgentFileConfig, useLocalize, useLazyEffect } from '~/hooks';
import { SharePointPickerDialog } from '~/components/SharePoint';
import FileRow from '~/components/Chat/Input/Files/FileRow';
import { useGetStartupConfig } from '~/data-provider';
import { isEphemeralAgent } from '~/common';

function KnaufFileSearch({
  agent_id,
  files: _files,
}: {
  agent_id: string;
  files?: [string, ExtendedFile][];
}) {
  const localize = useLocalize();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Map<string, ExtendedFile>>(new Map());
  const fileHandlingState = useMemo(() => ({ files, setFiles, conversation: null }), [files]);
  const [isPopoverActive, setIsPopoverActive] = useState(false);
  const [isSharePointDialogOpen, setIsSharePointDialogOpen] = useState(false);

  const { data: startupConfig } = useGetStartupConfig();
  const { endpointFileConfig, providerValue, endpointType } = useAgentFileConfig();
  const endpointOverride = providerValue || EModelEndpoint.agents;

  const { handleFileChange } = useFileHandlingNoChatContext(
    {
      additionalMetadata: { agent_id, tool_resource: EToolResources.file_search },
      endpointOverride,
      endpointTypeOverride: endpointType,
      fileSetter: setFiles,
    },
    fileHandlingState,
  );

  const { handleSharePointFiles, isProcessing, downloadProgress } =
    useSharePointFileHandlingNoChatContext(
      {
        additionalMetadata: { agent_id, tool_resource: EToolResources.file_search },
        endpointOverride,
        endpointTypeOverride: endpointType,
        fileSetter: setFiles,
      },
      fileHandlingState,
    );

  useLazyEffect(
    () => {
      if (_files) {
        setFiles(new Map(_files));
      }
    },
    [_files],
    750,
  );

  const isUploadDisabled = endpointFileConfig?.disabled ?? false;

  const sharePointEnabled = startupConfig?.sharePointFilePickerEnabled;
  const disabledUploadButton = isEphemeralAgent(agent_id);

  const handleSharePointFilesSelected = async (sharePointFiles: any[]) => {
    try {
      await handleSharePointFiles(sharePointFiles);
      setIsSharePointDialogOpen(false);
    } catch (error) {
      console.error('SharePoint file processing error:', error);
    }
  };
  if (isUploadDisabled) {
    return null;
  }

  const handleButtonClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    fileInputRef.current?.click();
  };

  const handleLocalFileClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    fileInputRef.current?.click();
  };

  const dropdownItems = [
    {
      label: localize('com_files_upload_local_machine'),
      onClick: handleLocalFileClick,
      icon: <Folder className="icon-md" />,
    },
    {
      label: localize('com_files_upload_sharepoint'),
      onClick: () => setIsSharePointDialogOpen(true),
      icon: <SharePointIcon className="icon-md" />,
    },
  ];

  const menuTrigger = (
    <Ariakit.MenuButton
      disabled={disabledUploadButton}
      className="btn btn-neutral border-token-border-light relative h-9 w-full rounded-lg text-sm font-medium"
    >
      <div className="flex w-full items-center justify-center gap-1">
        <AttachmentIcon className="text-token-text-primary h-4 w-4" />
        {localize('com_ui_upload_file_search')}
      </div>
    </Ariakit.MenuButton>
  );

  return (
    <div className="w-full">
      <div className="flex flex-col gap-3">
        <FileRow
          files={files}
          setFiles={setFiles}
          agent_id={agent_id}
          tool_resource={EToolResources.file_search}
          Wrapper={({ children }) => <div className="flex flex-wrap gap-2">{children}</div>}
        />
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
              disabled={disabledUploadButton}
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
            disabled={disabledUploadButton}
            onChange={handleFileChange}
          />
        </div>
        {agent_id ? null : (
          <div className="text-xs text-text-secondary">
            {localize('com_agents_file_search_disabled')}
          </div>
        )}
      </div>

      <SharePointPickerDialog
        isOpen={isSharePointDialogOpen}
        onOpenChange={setIsSharePointDialogOpen}
        onFilesSelected={handleSharePointFilesSelected}
        disabled={disabledUploadButton}
        isDownloading={isProcessing}
        downloadProgress={downloadProgress}
        maxSelectionCount={endpointFileConfig?.fileLimit}
      />
    </div>
  );
}

const MemoizedKnaufFileSearch = memo(KnaufFileSearch);
MemoizedKnaufFileSearch.displayName = 'KnaufFileSearch';

export default MemoizedKnaufFileSearch;
