import React, { createContext, useContext, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Constants } from 'librechat-data-provider';
import {
  getConversationCosts,
  type ConversationCostsResponse,
  type MessageCostSummary,
} from '~/knauf/data-provider/data-service';

interface KnaufCostContextValue {
  data?: ConversationCostsResponse;
  isLoading: boolean;
  refetch: () => void | Promise<unknown>;
  getMessageCost: (messageId?: string | null) => MessageCostSummary | null;
}

const KnaufCostContext = createContext<KnaufCostContextValue>({
  isLoading: false,
  refetch: () => undefined,
  getMessageCost: () => null,
});

function canFetchConversationCosts(conversationId?: string | null) {
  return (
    typeof conversationId === 'string' &&
    conversationId.length > 0 &&
    conversationId !== Constants.NEW_CONVO &&
    conversationId !== Constants.PENDING_CONVO &&
    conversationId !== Constants.SEARCH
  );
}

export function KnaufChatCostProvider({
  children,
  conversationId,
}: Readonly<{
  children: React.ReactNode;
  conversationId?: string | null;
}>) {
  const enabled = canFetchConversationCosts(conversationId);
  const query = useQuery<ConversationCostsResponse>({
    queryKey: ['knauf-conversation-costs', conversationId],
    queryFn: () => getConversationCosts(conversationId ?? ''),
    enabled,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const value = useMemo<KnaufCostContextValue>(
    () => ({
      data: query.data,
      isLoading: query.isFetching,
      refetch: query.refetch,
      getMessageCost: (messageId) => {
        if (!messageId || !query.data) {
          return null;
        }
        return query.data.messages[messageId] ?? null;
      },
    }),
    [query.data, query.isFetching, query.refetch],
  );

  return <KnaufCostContext.Provider value={value}>{children}</KnaufCostContext.Provider>;
}

export function useKnaufConversationCosts() {
  return useContext(KnaufCostContext);
}

export { canFetchConversationCosts };
