import React, { useRef, useState, useMemo, useCallback } from 'react';
import { useRecoilState } from 'recoil';
import * as Ariakit from '@ariakit/react';
import {
  Info,
  FileSearch,
  ImageUpIcon,
  FileType2Icon,
  FileImageIcon,
  TerminalSquareIcon,
} from 'lucide-react';
import {
  FileUpload,
  TooltipAnchor,
  DropdownPopup,
  AttachmentIcon,
  SharePointIcon,
} from '@librechat/client';
import {
  Providers,
  EToolResources,
  EModelEndpoint,
  isPermissiveMimeConfig,
  defaultAgentCapabilities,
  bedrockDocumentExtensions,
  isDocumentSupportedProvider,
} from 'librechat-data-provider';
import type { EndpointFileConfig, TConversation } from 'librechat-data-provider';
import type { ExtendedFile, FileSetter } from '~/common';
import {
  useAgentToolPermissions,
  useAgentCapabilities,
  useGetAgentsConfig,
  useFileHandlingNoChatContext,
  useLocalize,
} from '~/hooks';
import { useSharePointFileHandlingNoChatContext } from '~/hooks/Files/useSharePointFileHandling';
import { SharePointPickerDialog } from '~/components/SharePoint';
import { useGetStartupConfig } from '~/data-provider';
import { ephemeralAgentByConvoId } from '~/store';
import { MenuItemProps } from '~/common';
import { cn } from '~/utils';
// [knauf] Emit Adobe data-layer app_interaction events for chat file upload selections.
import { dispatchAdobeAppInteraction } from '~/knauf/analytics/adobe';
// [knauf] "Supported file types" dialog opened from the upload-menu hint row.
import KnaufUploadFormatsDialog from '~/knauf/components/Chat/KnaufUploadFormatsDialog';
// End [knauf]

type FileUploadType =
  | 'image'
  | 'document'
  | 'image_document'
  | 'image_document_extended'
  | 'image_document_video_audio'
  // [knauf] Chat "Upload files" allow-list (mirrors librechat.yaml fileConfig). KK20-190.
  | 'knauf_allowed';
// End [knauf]

interface AttachFileMenuProps {
  agentId?: string | null;
  endpoint?: string | null;
  disabled?: boolean | null;
  conversationId: string;
  endpointType?: EModelEndpoint | string;
  endpointFileConfig?: EndpointFileConfig;
  useResponsesApi?: boolean;
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
  conversation: TConversation | null;
}

const AttachFileMenu = ({
  agentId,
  endpoint,
  disabled,
  endpointType,
  conversationId,
  endpointFileConfig,
  useResponsesApi,
  files,
  setFiles,
  setFilesLoading,
  conversation,
}: AttachFileMenuProps) => {
  const localize = useLocalize();
  const isUploadDisabled = disabled ?? false;
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPopoverActive, setIsPopoverActive] = useState(false);
  const [ephemeralAgent, setEphemeralAgent] = useRecoilState(
    ephemeralAgentByConvoId(conversationId),
  );
  const [toolResource, setToolResource] = useState<EToolResources | undefined>();
  // [knauf] Controls the "Supported file types" dialog (opened from the menu hint row). KK20-190.
  const [formatsDialogOpen, setFormatsDialogOpen] = useState(false);
  const { handleFileChange } = useFileHandlingNoChatContext(undefined, {
    files,
    setFiles,
    setFilesLoading,
    conversation,
  });
  const { handleSharePointFiles, isProcessing, downloadProgress } =
    useSharePointFileHandlingNoChatContext(
      { toolResource },
      { files, setFiles, setFilesLoading, conversation },
    );

  const { agentsConfig } = useGetAgentsConfig();
  const { data: startupConfig } = useGetStartupConfig();
  const sharePointEnabled = startupConfig?.sharePointFilePickerEnabled;

  const [isSharePointDialogOpen, setIsSharePointDialogOpen] = useState(false);

  /** TODO: Ephemeral Agent Capabilities
   * Allow defining agent capabilities on a per-endpoint basis
   * Use definition for agents endpoint for ephemeral agents
   * */
  const capabilities = useAgentCapabilities(agentsConfig?.capabilities ?? defaultAgentCapabilities);

  const { fileSearchAllowedByAgent, codeAllowedByAgent, provider } = useAgentToolPermissions(
    agentId,
    ephemeralAgent,
  );

  const handleUploadClick = useCallback(
    (fileType?: FileUploadType) => {
      if (!inputRef.current) {
        return;
      }
      inputRef.current.value = '';
      if (
        fileType !== undefined &&
        isPermissiveMimeConfig(endpointFileConfig?.supportedMimeTypes)
      ) {
        inputRef.current.accept = '';
      } else if (fileType === 'image') {
        inputRef.current.accept = 'image/*,.heif,.heic';
      } else if (fileType === 'document') {
        inputRef.current.accept = '.pdf,application/pdf';
      } else if (fileType === 'image_document') {
        inputRef.current.accept = 'image/*,.heif,.heic,.pdf,application/pdf';
      } else if (fileType === 'image_document_extended') {
        inputRef.current.accept = `image/*,.heif,.heic,${bedrockDocumentExtensions}`;
      } else if (fileType === 'image_document_video_audio') {
        inputRef.current.accept = 'image/*,.heif,.heic,.pdf,application/pdf,video/*,audio/*';
      } else if (fileType === 'knauf_allowed') {
        // [knauf] Restrict the chat file picker to the Knauf allow-list
        // (mirrors fileConfig.supportedMimeTypes in librechat.yaml). Documents
        // route to File Search (RAG); images route to the vision path
        // (per-file split in useFileHandling). KK20-190.
        inputRef.current.accept =
          '.pdf,.docx,.pptx,.xlsx,.csv,.txt,.md,.json,image/png,image/jpeg,image/webp';
      } else {
        inputRef.current.accept = '';
      }
      inputRef.current.click();
      inputRef.current.accept = '';
    },
    [endpointFileConfig?.supportedMimeTypes],
  );

  const dropdownItems = useMemo(() => {
    const createMenuItems = (onAction: (fileType?: FileUploadType) => void) => {
      const items: MenuItemProps[] = [];

      let currentProvider = provider || endpoint;

      // This will be removed in a future PR to formally normalize Providers comparisons to be case insensitive
      if (currentProvider?.toLowerCase() === Providers.OPENROUTER) {
        currentProvider = Providers.OPENROUTER;
      }

      const isAzureWithResponsesApi =
        currentProvider === EModelEndpoint.azureOpenAI && useResponsesApi;

      if (
        isDocumentSupportedProvider(endpointType) ||
        isDocumentSupportedProvider(currentProvider) ||
        isAzureWithResponsesApi
      ) {
        items.push({
          // [knauf] Generic "Upload files" label instead of upstream's "Upload
          // to Provider" — Knauf users don't think in provider/endpoint terms.
          // On the Knauf Azure chat this item routes documents to File Search
          // (see onClick); the label deliberately hides that mechanism.
          label: localize('com_ui_upload_files'),
          // End [knauf]
          onClick: () => {
            // [knauf] On the Knauf Azure chat, "Upload files" feeds documents
            // into the chat-scoped File Search (RAG) corpus via an ephemeral
            // agent, instead of the provider whole-document upload. Images
            // still go to the vision path (split per-file in useFileHandling,
            // since the server rejects images for the file_search resource).
            // Keep the "Upload files" label — no file-search jargon for users.
            // Other document-capable providers keep upstream provider-upload.
            // KK20-190.
            //
            // NB: do NOT gate on `fileSearchAllowedByAgent` here — for an
            // ephemeral (default) chat that flag is `ephemeralAgent.file_search
            // ?? false`, i.e. false until file_search is enabled. This click is
            // what enables it (setEphemeralAgent below), so gating on it would
            // be a chicken-and-egg that falls back to the provider path and the
            // picker would only offer images + PDF. `capabilities.fileSearchEnabled`
            // (from endpoints.agents.capabilities) is the correct platform gate.
            const useKnaufFileSearch = isAzureWithResponsesApi && capabilities.fileSearchEnabled;
            if (useKnaufFileSearch) {
              setToolResource(EToolResources.file_search);
              setEphemeralAgent((prev) => ({
                ...prev,
                [EToolResources.file_search]: true,
              }));
              onAction('knauf_allowed');
              return;
            }
            // End [knauf]
            setToolResource(undefined);
            let fileType: Exclude<FileUploadType, 'image' | 'document'> = 'image_document';
            if (currentProvider === Providers.GOOGLE || currentProvider === Providers.OPENROUTER) {
              fileType = 'image_document_video_audio';
            } else if (
              currentProvider === Providers.BEDROCK ||
              endpointType === EModelEndpoint.bedrock
            ) {
              fileType = 'image_document_extended';
            }
            onAction(fileType);
          },
          icon: <FileImageIcon className="icon-md" />,
        });
        // [knauf] On the Knauf File Search chat, add a trailing ⓘ button to the
        // "Upload files" row that opens KnaufUploadFormatsDialog (accepted formats
        // + limits + the legacy .doc/.xls/.ppt → OOXML conversion steps). The row's
        // primary click still uploads; the ⓘ stops propagation, closes the menu, and
        // opens the dialog. `label`/`icon` stay set so the seam tests (which mock
        // DropdownPopup and ignore `render`) still resolve the item. Same gate as the
        // routing above. KK20-190 (upload-guidance follow-up).
        if (isAzureWithResponsesApi && capabilities.fileSearchEnabled) {
          const uploadItem = items[items.length - 1];
          uploadItem.render = (props) => (
            <div {...props}>
              <span className="flex items-center gap-2">
                <FileImageIcon className="icon-md" />
                {localize('com_ui_upload_files')}
              </span>
              <button
                type="button"
                aria-label={localize('com_knauf_upload_formats_title')}
                className="ml-auto rounded p-1 text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsPopoverActive(false);
                  setFormatsDialogOpen(true);
                }}
              >
                <Info className="icon-sm" aria-hidden="true" />
              </button>
            </div>
          );
        }
        // End [knauf]
      } else {
        items.push({
          label: localize('com_ui_upload_image_input'),
          onClick: () => {
            setToolResource(undefined);
            onAction('image');
          },
          icon: <ImageUpIcon className="icon-md" />,
        });
      }

      if (capabilities.contextEnabled) {
        items.push({
          label: localize('com_ui_upload_ocr_text'),
          onClick: () => {
            setToolResource(EToolResources.context);
            onAction();
          },
          icon: <FileType2Icon className="icon-md" />,
        });
      }

      // [knauf] Hide the "Upload for File Search" item from the chat paperclip
      // menu. File-search uploads are still supported, but only through the
      // agent builder's Data Knowledge panel (KnaufFileSearch) — adding files
      // from chat would create an ad-hoc RAG corpus tied to the conversation,
      // which conflicts with the Knauf model where knowledge is curated per
      // agent. The upstream gate is preserved below for reference / easy
      // un-hiding; flip KNAUF_SHOW_FILE_SEARCH_IN_CHAT to true to restore.
      // `as boolean` widens the literal so SonarCloud doesn't flag the `&&`
      // below as a constant/gratuitous condition (S6644 / S2589) — see
      // .claude/notes/ANTI_PATTERNS.md.
      const KNAUF_SHOW_FILE_SEARCH_IN_CHAT = false as boolean;
      if (
        KNAUF_SHOW_FILE_SEARCH_IN_CHAT &&
        capabilities.fileSearchEnabled &&
        fileSearchAllowedByAgent
      ) {
        items.push({
          label: localize('com_ui_upload_file_search'),
          onClick: () => {
            setToolResource(EToolResources.file_search);
            setEphemeralAgent((prev) => ({
              ...prev,
              [EToolResources.file_search]: true,
            }));
            onAction();
          },
          icon: <FileSearch className="icon-md" />,
        });
      }
      // End [knauf]

      if (capabilities.codeEnabled && codeAllowedByAgent) {
        items.push({
          label: localize('com_ui_upload_code_files'),
          onClick: () => {
            setToolResource(EToolResources.execute_code);
            setEphemeralAgent((prev) => ({
              ...prev,
              [EToolResources.execute_code]: true,
            }));
            onAction();
          },
          icon: <TerminalSquareIcon className="icon-md" />,
        });
      }

      return items;
    };

    const localItems = createMenuItems(handleUploadClick);

    if (sharePointEnabled) {
      const sharePointItems = createMenuItems(() => {
        setIsSharePointDialogOpen(true);
        // Note: toolResource will be set by the specific item clicked
      });
      localItems.push({
        label: localize('com_files_upload_sharepoint'),
        onClick: () => {},
        icon: <SharePointIcon className="icon-md" />,
        subItems: sharePointItems,
      });
      return localItems;
    }

    return localItems;
  }, [
    localize,
    endpoint,
    provider,
    endpointType,
    capabilities,
    useResponsesApi,
    handleUploadClick,
    setToolResource,
    setEphemeralAgent,
    sharePointEnabled,
    codeAllowedByAgent,
    fileSearchAllowedByAgent,
    setIsSharePointDialogOpen,
    // [knauf] trailing ⓘ on the Upload files row opens the formats dialog + closes the menu
    setFormatsDialogOpen,
    setIsPopoverActive,
    // End [knauf]
  ]);

  const menuTrigger = (
    <TooltipAnchor
      render={
        <Ariakit.MenuButton
          disabled={isUploadDisabled}
          id="attach-file-menu-button"
          aria-label="Attach File Options"
          className={cn(
            'flex size-9 items-center justify-center rounded-full p-1 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-opacity-50',
            isPopoverActive && 'bg-surface-hover',
          )}
        >
          <div className="flex w-full items-center justify-center gap-2">
            <AttachmentIcon />
          </div>
        </Ariakit.MenuButton>
      }
      id="attach-file-menu-button"
      description={localize('com_sidepanel_attach_files')}
      disabled={isUploadDisabled}
    />
  );
  // [knauf] Centralised chat-upload interaction event. The payload avoids
  // filenames, sizes, paths, and file-source metadata.
  const dispatchChatUploadInteraction = useCallback(() => {
    dispatchAdobeAppInteraction({
      action: 'upload_chat_file',
      component: 'chat_composer',
      eventSpecification: 'upload_chat_file',
      pageSection: 'chat',
    });
  }, []);
  // End [knauf]

  const handleSharePointFilesSelected = async (sharePointFiles: any[]) => {
    try {
      await handleSharePointFiles(sharePointFiles);
      // [knauf] Track the upload action only after the user selected files
      // and SharePoint processing completed successfully.
      if (sharePointFiles.length > 0) {
        dispatchChatUploadInteraction();
      }
      // End [knauf]
      setIsSharePointDialogOpen(false);
    } catch (error) {
      console.error('SharePoint file processing error:', error);
    }
  };

  return (
    <>
      <FileUpload
        ref={inputRef}
        handleFileChange={(e) => {
          // [knauf] Track local chat upload selections without collecting
          // file metadata.
          if ((e.target.files?.length ?? 0) > 0) {
            dispatchChatUploadInteraction();
          }
          // End [knauf]
          handleFileChange(e, toolResource);
        }}
      >
        <DropdownPopup
          menuId="attach-file-menu"
          className="overflow-visible"
          isOpen={isPopoverActive}
          setIsOpen={setIsPopoverActive}
          modal={true}
          unmountOnHide={true}
          trigger={menuTrigger}
          items={dropdownItems}
          iconClassName="mr-0"
        />
      </FileUpload>
      <SharePointPickerDialog
        isOpen={isSharePointDialogOpen}
        onOpenChange={setIsSharePointDialogOpen}
        onFilesSelected={handleSharePointFilesSelected}
        isDownloading={isProcessing}
        downloadProgress={downloadProgress}
        maxSelectionCount={endpointFileConfig?.fileLimit}
      />
      {/* [knauf] Supported-formats + legacy-migration guidance (opened from the menu hint row). */}
      <KnaufUploadFormatsDialog open={formatsDialogOpen} onOpenChange={setFormatsDialogOpen} />
      {/* End [knauf] */}
    </>
  );
};

export default React.memo(AttachFileMenu);
