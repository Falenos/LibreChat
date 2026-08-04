import type { ReactNode } from 'react';
import { RecoilRoot } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { ContentTypes, QueryKeys } from 'librechat-data-provider';
import { useRefreshEditedArtifact } from './useRefreshEditedArtifact';

const mockUseLatestMessage = jest.fn();

jest.mock('~/hooks/Messages/useLatestMessage', () => ({
  useLatestMessage: (...args: unknown[]) => mockUseLatestMessage(...args),
}));

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ conversationId: 'conversation-1' }),
}));

const toolMessage = (output: string) => ({
  messageId: 'assistant-2',
  content: [
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: 'call-1',
        name: 'edit_artifact',
        progress: 1,
        output,
      },
    },
  ],
});

describe('useRefreshEditedArtifact', () => {
  it('refetches the current messages after a successful server-side edit', async () => {
    mockUseLatestMessage.mockReturnValue(toolMessage('{"status":"updated"}'));
    const queryClient = new QueryClient();
    const refetch = jest.spyOn(queryClient, 'refetchQueries').mockResolvedValue(undefined);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RecoilRoot>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </RecoilRoot>
    );

    renderHook(() => useRefreshEditedArtifact(), { wrapper });

    await waitFor(() =>
      expect(refetch).toHaveBeenCalledWith([QueryKeys.messages, 'conversation-1']),
    );
  });

  it('does not refetch for a rejected edit', async () => {
    mockUseLatestMessage.mockReturnValue(toolMessage('{"status":"error"}'));
    const queryClient = new QueryClient();
    const refetch = jest.spyOn(queryClient, 'refetchQueries').mockResolvedValue(undefined);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RecoilRoot>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </RecoilRoot>
    );

    renderHook(() => useRefreshEditedArtifact(), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(refetch).not.toHaveBeenCalled();
  });
});
