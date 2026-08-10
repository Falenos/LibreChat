import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useRecoilValue } from 'recoil';
import { useQueryClient } from '@tanstack/react-query';
import { ContentTypes, QueryKeys } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { useLatestMessage } from '~/hooks/Messages/useLatestMessage';
import store from '~/store';

const successfulEditCallId = (message: TMessage | null): string | null => {
  for (const part of message?.content ?? []) {
    if (part.type !== ContentTypes.TOOL_CALL || !('tool_call' in part)) {
      continue;
    }
    const call = part.tool_call;
    if (
      !('name' in call) ||
      call.name !== 'edit_artifact' ||
      call.progress !== 1 ||
      !('output' in call) ||
      typeof call.output !== 'string' ||
      typeof call.id !== 'string'
    ) {
      continue;
    }
    try {
      if (JSON.parse(call.output)?.status === 'updated') {
        return call.id;
      }
    } catch {
      return null;
    }
  }
  return null;
};

export function useRefreshEditedArtifact() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const latestMessage = useLatestMessage(0);
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(0));
  const queryClient = useQueryClient();
  const refreshedCallId = useRef<string | null>(null);

  useEffect(() => {
    if (isSubmitting || !conversationId) {
      return;
    }
    const callId = successfulEditCallId(latestMessage);
    if (!callId || refreshedCallId.current === callId) {
      return;
    }
    refreshedCallId.current = callId;
    void queryClient.refetchQueries([QueryKeys.messages, conversationId]);
  }, [conversationId, isSubmitting, latestMessage, queryClient]);
}
