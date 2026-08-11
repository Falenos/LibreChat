// [knauf] Conversation delete should evict deleted chat attachments from the global files cache.
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { TConversation, TFile, TMessage } from 'librechat-data-provider';
import { useDeleteConversationMutation } from './mutations';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      deleteConversation: jest.fn(),
    },
  };
});

jest.mock('~/utils', () => {
  const actual = jest.requireActual('~/utils');
  return {
    ...actual,
    removeConvoFromAllQueries: jest.fn(),
  };
});

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

describe('conversation delete mutation [knauf]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('removes deleted conversation attachment files from the files cache immediately', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    queryClient.setQueryData<TConversation>([QueryKeys.conversation, 'convo-1'], {
      conversationId: 'convo-1',
      chatProjectId: null,
    } as TConversation);
    queryClient.setQueryData<TMessage[]>([QueryKeys.messages, 'convo-1'], [
      {
        messageId: 'msg-1',
        conversationId: 'convo-1',
        files: [{ file_id: 'file-1' }],
        attachments: [{ file_id: 'file-2', conversationId: 'convo-1' }],
      } as TMessage,
    ]);
    queryClient.setQueryData<TFile[]>([QueryKeys.files], [
      { file_id: 'file-1', filename: 'delete-1.txt' } as TFile,
      { file_id: 'file-2', filename: 'delete-2.txt' } as TFile,
      { file_id: 'file-3', filename: 'keep.txt' } as TFile,
    ]);

    (dataService.deleteConversation as jest.Mock).mockResolvedValue({ success: true });

    const { result } = renderHook(() => useDeleteConversationMutation(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ conversationId: 'convo-1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData<TFile[]>([QueryKeys.files])).toEqual([
      expect.objectContaining({ file_id: 'file-3' }),
    ]);
    expect(queryClient.getQueryData<TMessage[]>([QueryKeys.messages, 'convo-1'])).toBeUndefined();
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.files]);
  });
});
