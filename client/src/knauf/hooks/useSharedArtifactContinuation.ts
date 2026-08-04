import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { useToastContext } from '@librechat/client';
import { NotificationSeverity } from '~/common';
import useLocalize from '~/hooks/useLocalize';
import useNavigateToConvo from '~/hooks/Conversations/useNavigateToConvo';
import { useChatContext } from '~/Providers';
import { postSharedArtifactContinuation } from '~/knauf/data-provider/data-service';
import {
  SHARED_ARTIFACT_PARAM,
  SHARED_ARTIFACT_PENDING_OPEN,
} from '~/knauf/utils/sharedArtifactContinuation';
import store from '~/store';

const inFlightShareIds = new Set<string>();

export default function useSharedArtifactContinuation({
  conversationId,
}: Readonly<{
  conversationId: string;
}>) {
  const localize = useLocalize();
  const { navigateToConvo } = useNavigateToConvo();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const { conversation } = useChatContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const artifacts = useRecoilValue(store.artifactsState);
  const setCurrentArtifactId = useSetRecoilState(store.currentArtifactId);
  const setArtifactsVisibility = useSetRecoilState(store.artifactsVisibility);
  const shareId = searchParams.get(SHARED_ARTIFACT_PARAM) ?? '';
  const enabled =
    conversationId === Constants.NEW_CONVO && shareId.length > 0 && conversation?.endpoint != null;

  useEffect(() => {
    if (typeof sessionStorage === 'undefined') {
      return;
    }
    const rawPending = sessionStorage.getItem(SHARED_ARTIFACT_PENDING_OPEN);
    if (!rawPending) {
      return;
    }

    try {
      const pending = JSON.parse(rawPending) as { conversationId?: string; artifactId?: string };
      if (
        pending.conversationId !== conversationId ||
        !pending.artifactId ||
        artifacts?.[pending.artifactId] == null
      ) {
        return;
      }
      setCurrentArtifactId(pending.artifactId);
      setArtifactsVisibility(true);
      sessionStorage.removeItem(SHARED_ARTIFACT_PENDING_OPEN);
    } catch {
      sessionStorage.removeItem(SHARED_ARTIFACT_PENDING_OPEN);
    }
  }, [artifacts, conversationId, setArtifactsVisibility, setCurrentArtifactId]);

  useEffect(() => {
    if (!enabled || !conversation || inFlightShareIds.has(shareId)) {
      return;
    }

    inFlightShareIds.add(shareId);
    const removeShareParam = () => {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete(SHARED_ARTIFACT_PARAM);
      setSearchParams(nextParams, { replace: true });
    };

    void postSharedArtifactContinuation(shareId, conversation)
      .then((result) => {
        const clonedConversationId = result.conversation.conversationId;
        if (!clonedConversationId) {
          throw new Error('Continuation response is missing a conversation ID');
        }

        removeShareParam();
        queryClient.invalidateQueries([QueryKeys.allConversations]);
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem(
            SHARED_ARTIFACT_PENDING_OPEN,
            JSON.stringify({
              conversationId: clonedConversationId,
              artifactId: result.artifactId,
            }),
          );
        }
        navigateToConvo(result.conversation, {
          currentConvoId: String(Constants.NEW_CONVO),
        });
      })
      .catch(() => {
        removeShareParam();
        showToast({
          message: localize('com_knauf_artifact_continue_error'),
          severity: NotificationSeverity.ERROR,
          showIcon: true,
        });
      })
      .finally(() => {
        inFlightShareIds.delete(shareId);
      });
  }, [
    conversation,
    enabled,
    localize,
    navigateToConvo,
    queryClient,
    searchParams,
    setSearchParams,
    shareId,
    showToast,
  ]);
}
