import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import debounce from 'lodash/debounce';
import { SetterOrUpdater, useRecoilValue } from 'recoil';
import { LocalStorageKeys, Constants } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { clearDraft, getDraft, setDraft } from '~/utils';
import { useChatFormContext } from '~/Providers';
import { useGetFiles } from '~/data-provider';
import store from '~/store';

// [knauf] Temporary conversation keys are tab-scoped; real conversation drafts remain persistent. KK20-227.
const isTemporaryConversation = (id?: string | null) =>
  id === Constants.NEW_CONVO || id === Constants.PENDING_CONVO;
const draftStorage = (id: string) => (isTemporaryConversation(id) ? sessionStorage : localStorage);
// End [knauf]

export const useAutoSave = ({
  isSubmitting,
  conversationId: _conversationId,
  textAreaRef,
  setFiles,
  files,
}: {
  isSubmitting?: boolean;
  conversationId?: string | null;
  textAreaRef?: React.RefObject<HTMLTextAreaElement>;
  files: Map<string, ExtendedFile>;
  setFiles: SetterOrUpdater<Map<string, ExtendedFile>>;
}) => {
  // setting for auto-save
  const { setValue } = useChatFormContext();
  const saveDrafts = useRecoilValue<boolean>(store.saveDrafts);
  const conversationId = isSubmitting ? Constants.PENDING_CONVO : _conversationId;

  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const fileIds = useMemo(() => Array.from(files.keys()), [files]);
  const { data: fileList } = useGetFiles<TFile[]>();

  const restoreFiles = useCallback(
    (id: string) => {
      const filesDraft = JSON.parse(
        (draftStorage(id).getItem(`${LocalStorageKeys.FILES_DRAFT}${id}`) ?? '') || '[]',
      ) as string[];

      if (filesDraft.length === 0) {
        setFiles(new Map());
        return;
      }

      // Retrieve files stored in localStorage from files in fileList and set them to `setFiles`
      // If a file is found with `temp_file_id`, use `temp_file_id` as a key in `setFiles`
      filesDraft.forEach((fileId) => {
        const fileData = fileList?.find((f) => f.file_id === fileId);
        const tempFileData = fileList?.find((f) => f.temp_file_id === fileId);
        const { fileToRecover, fileIdToRecover } = fileData
          ? { fileToRecover: fileData, fileIdToRecover: fileId }
          : {
              fileToRecover: tempFileData,
              fileIdToRecover: (tempFileData?.temp_file_id ?? '') || fileId,
            };

        if (fileToRecover) {
          setFiles((currentFiles) => {
            const updatedFiles = new Map(currentFiles);
            updatedFiles.set(fileIdToRecover, {
              ...fileToRecover,
              progress: 1,
              attached: true,
              size: fileToRecover.bytes,
            });
            return updatedFiles;
          });
        }
      });
    },
    [fileList, setFiles],
  );

  const restoreText = useCallback(
    (id: string) => {
      setValue('text', getDraft(id) ?? '');
    },
    [setValue],
  );

  const saveText = useCallback(
    (id: string) => {
      if (!textAreaRef?.current) {
        return;
      }
      // Save the draft of the current conversation before switching
      if (textAreaRef.current.value === '' || textAreaRef.current.value.length === 1) {
        clearDraft(id);
      } else {
        setDraft({ id, value: textAreaRef.current.value });
      }
    },
    [textAreaRef],
  );

  useEffect(() => {
    // This useEffect is responsible for setting up and cleaning up the auto-save functionality
    // for the text area input. It saves the text to localStorage with a debounce to prevent
    // excessive writes.
    if (!saveDrafts || conversationId == null || conversationId === '') {
      return;
    }

    /** Use shorter debounce for saving text (25ms) to capture rapid typing */
    const handleInputFast = debounce(
      (value: string) => setDraft({ id: conversationId, value }),
      25,
    );

    /** Use longer debounce for clearing empty values (850ms) to prevent accidental draft loss */
    const handleInputSlow = debounce(
      (value: string) => setDraft({ id: conversationId, value }),
      850,
    );

    const eventListener = (e: Event) => {
      const target = e.target as HTMLTextAreaElement;
      const value = target.value;

      /** Cancel any pending operations to avoid conflicts */
      handleInputFast.cancel();
      handleInputSlow.cancel();

      /** If empty, use long delay to prevent accidental clearing
       * Otherwise use short delay to capture rapid typing */
      if (value === '') {
        handleInputSlow(value);
      } else {
        handleInputFast(value);
      }
    };

    const textArea = textAreaRef?.current;
    if (textArea) {
      textArea.addEventListener('input', eventListener);
    }

    return () => {
      if (textArea) {
        textArea.removeEventListener('input', eventListener);
      }
      handleInputFast.cancel();
      handleInputSlow.cancel();
    };
  }, [conversationId, saveDrafts, textAreaRef]);

  const prevConversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    // This useEffect is responsible for saving the current conversation's draft and
    // restoring the new conversation's draft when switching between conversations.
    // It handles both text and file drafts, ensuring that the user's input is preserved
    // across different conversations.

    if (!saveDrafts || conversationId == null || conversationId === '') {
      return;
    }
    if (conversationId === currentConversationId) {
      return;
    }

    // [knauf] KK20-227 — preserve in-memory uploads while a temporary draft
    // migrates to its real conversation; useGetFiles can still be stale.
    const temporaryConversationId = prevConversationIdRef.current;
    const isTemporaryConversationTransition =
      isTemporaryConversation(temporaryConversationId) &&
      !isTemporaryConversation(conversationId) &&
      conversationId.length > 3;
    if (!isTemporaryConversationTransition) {
      // clear attachment files when switching conversation
      setFiles(new Map());
    }
    // End [knauf]

    try {
      // Check for transition from a temporary conversation to a valid conversationId
      if (isTemporaryConversationTransition && temporaryConversationId != null) {
        // [knauf] KK20-227 — migrate this tab's temporary text/files into the real conversation.
        const pendingDraft = sessionStorage.getItem(
          `${LocalStorageKeys.TEXT_DRAFT}${temporaryConversationId}`,
        );

        // Clear the pending text draft, if it exists, and save the current draft to the new conversationId;
        // otherwise, save the current text area value to the new conversationId
        sessionStorage.removeItem(`${LocalStorageKeys.TEXT_DRAFT}${temporaryConversationId}`);
        if (pendingDraft) {
          localStorage.setItem(`${LocalStorageKeys.TEXT_DRAFT}${conversationId}`, pendingDraft);
        } else if (textAreaRef?.current?.value) {
          setDraft({ id: conversationId, value: textAreaRef.current.value });
        }
        const pendingFileDraft = sessionStorage.getItem(
          `${LocalStorageKeys.FILES_DRAFT}${temporaryConversationId}`,
        );

        if (pendingFileDraft) {
          localStorage.setItem(
            `${LocalStorageKeys.FILES_DRAFT}${conversationId}`,
            pendingFileDraft,
          );
          sessionStorage.removeItem(`${LocalStorageKeys.FILES_DRAFT}${temporaryConversationId}`);
          const filesDraft = JSON.parse(pendingFileDraft || '[]') as string[];
          if (filesDraft.length > 0) {
            restoreFiles(conversationId);
          }
        }
        // End [knauf]
      } else if (currentConversationId != null && currentConversationId) {
        saveText(currentConversationId);
      }

      restoreText(conversationId);
      // [knauf] KK20-227 — the in-memory map is authoritative during the
      // temporary-to-current transition because useGetFiles can still be stale.
      if (!isTemporaryConversationTransition || fileIds.length === 0) {
        restoreFiles(conversationId);
      }
      // End [knauf]
    } catch (e) {
      console.error(e);
    }

    prevConversationIdRef.current = conversationId;
    setCurrentConversationId(conversationId);
  }, [
    currentConversationId,
    conversationId,
    // [knauf] KK20-227 — re-evaluate pending-transition restoration when queued files change.
    fileIds.length,
    // End [knauf]
    restoreFiles,
    textAreaRef,
    restoreText,
    saveDrafts,
    saveText,
    setFiles,
  ]);

  useEffect(() => {
    // This useEffect is responsible for saving or removing the current conversation's file drafts
    // in localStorage whenever the file attachments change.
    // It ensures that the file drafts are kept up-to-date and can be restored
    // when the conversation is revisited.

    if (
      !saveDrafts ||
      conversationId == null ||
      conversationId === '' ||
      currentConversationId !== conversationId
    ) {
      return;
    }

    // [knauf] KK20-227 — temporary file drafts are tab-scoped; real conversation files stay local.
    if (fileIds.length === 0) {
      draftStorage(conversationId).removeItem(`${LocalStorageKeys.FILES_DRAFT}${conversationId}`);
    } else {
      draftStorage(conversationId).setItem(
        `${LocalStorageKeys.FILES_DRAFT}${conversationId}`,
        JSON.stringify(fileIds),
      );
    }
    // End [knauf]
  }, [files, conversationId, saveDrafts, currentConversationId, fileIds]);
};
