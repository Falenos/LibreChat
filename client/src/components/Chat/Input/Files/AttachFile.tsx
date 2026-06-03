import React, { useCallback, useRef } from 'react';
import { FileUpload, TooltipAnchor, AttachmentIcon } from '@librechat/client';
import type { TConversation } from 'librechat-data-provider';
import type { ExtendedFile, FileSetter } from '~/common';
import { useFileHandlingNoChatContext, useLocalize } from '~/hooks';
import { cn } from '~/utils';
// [knauf] Emit Adobe data-layer app_interaction events for chat file upload selections.
import { dispatchAdobeAppInteraction } from '~/knauf/analytics/adobe';
// End [knauf]

const AttachFile = ({
  disabled,
  files,
  setFiles,
  setFilesLoading,
  conversation,
}: {
  disabled?: boolean | null;
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
  conversation: TConversation | null;
}) => {
  const localize = useLocalize();
  const inputRef = useRef<HTMLInputElement>(null);
  const isUploadDisabled = disabled ?? false;

  const { handleFileChange } = useFileHandlingNoChatContext(undefined, {
    files,
    setFiles,
    setFilesLoading,
    conversation,
  });
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

  return (
    <FileUpload
      ref={inputRef}
      handleFileChange={(event: React.ChangeEvent<HTMLInputElement>) => {
        // [knauf] Track local chat upload selections without collecting file
        // metadata.
        if ((event.target.files?.length ?? 0) > 0) {
          dispatchChatUploadInteraction();
        }
        // End [knauf]
        handleFileChange(event);
      }}
    >
      <TooltipAnchor
        description={localize('com_sidepanel_attach_files')}
        id="attach-file"
        disabled={isUploadDisabled}
        render={
          <button
            type="button"
            aria-label={localize('com_sidepanel_attach_files')}
            disabled={isUploadDisabled}
            className={cn(
              'flex size-9 items-center justify-center rounded-full p-1 transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-opacity-50',
            )}
            onKeyDownCapture={(e) => {
              if (!inputRef.current) {
                return;
              }
              if (e.key === 'Enter' || e.key === ' ') {
                inputRef.current.value = '';
                inputRef.current.click();
              }
            }}
            onClick={() => {
              if (!inputRef.current) {
                return;
              }
              inputRef.current.value = '';
              inputRef.current.click();
            }}
          >
            <div className="flex w-full items-center justify-center gap-2">
              <AttachmentIcon />
            </div>
          </button>
        }
      />
    </FileUpload>
  );
};

export default React.memo(AttachFile);
