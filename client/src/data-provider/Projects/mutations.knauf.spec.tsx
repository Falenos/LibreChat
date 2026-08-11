// [knauf] KK20-248 — project mutation cache invalidation coverage.
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { TConversation, TFile } from 'librechat-data-provider';
import { useDeleteProjectFileMutation, useDeleteProjectMutation } from './mutations';

const mockNavigate = jest.fn();
const mockNewConversation = jest.fn();
const mockUseRecoilCallback = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('~/hooks', () => ({
  useNewConvo: () => ({ newConversation: mockNewConversation }),
}));

jest.mock('recoil', () => ({
  useRecoilCallback: (...args: unknown[]) => mockUseRecoilCallback(...args),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    conversationByIndex: jest.fn(),
    updateConversationSelector: jest.fn(() => 'updateConversationSelector'),
  },
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      deleteProject: jest.fn(),
      deleteProjectFile: jest.fn(),
    },
  };
});

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

describe('project file mutations [knauf]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseRecoilCallback.mockReset();
  });

  it('invalidates related caches and removes the deleted file from the files cache', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    queryClient.setQueryData<TFile[]>([QueryKeys.files], [
      { file_id: 'file-1', filename: 'project.txt' } as TFile,
      { file_id: 'file-2', filename: 'keep.txt' } as TFile,
    ]);
    (dataService.deleteProjectFile as jest.Mock).mockResolvedValue({ deleted: true });

    const { result } = renderHook(() => useDeleteProjectFileMutation(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({ projectId: 'project-1', file_id: 'file-1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(dataService.deleteProjectFile).toHaveBeenCalledWith({
      projectId: 'project-1',
      file_id: 'file-1',
    });
    expect(queryClient.getQueryData<TFile[]>([QueryKeys.files])).toEqual([
      expect.objectContaining({ file_id: 'file-2' }),
    ]);
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.files]);
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.projectFiles, 'project-1']);
  });

  it('resets the open chat and removes cached project files when deleting the active project', async () => {
    const activeConversation = {
      conversationId: 'convo-1',
      chatProjectId: 'project-1',
    } as TConversation;

    mockUseRecoilCallback
      .mockImplementationOnce(() => jest.fn(async () => activeConversation))
      .mockImplementationOnce(() => jest.fn(async () => true));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const removeSpy = jest.spyOn(queryClient, 'removeQueries');
    queryClient.setQueryData([QueryKeys.files], [
      { file_id: 'file-1', filename: 'project.txt' },
      { file_id: 'file-2', filename: 'keep.txt' },
    ]);
    queryClient.setQueryData([QueryKeys.projectFiles, 'project-1'], {
      files: [{ file_id: 'file-1', filename: 'project.txt' }],
    });
    (dataService.deleteProject as jest.Mock).mockResolvedValue({ deletedCount: 1, modifiedCount: 1 });

    const { result } = renderHook(() => useDeleteProjectMutation(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate('project-1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData<TFile[]>([QueryKeys.files])).toEqual([
      expect.objectContaining({ file_id: 'file-2' }),
    ]);
    expect(removeSpy).toHaveBeenCalledWith([QueryKeys.projectFiles, 'project-1'], { exact: false });
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.conversationTags]);
    expect(mockNewConversation).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/c/new', { replace: true });
  });
});
// End [knauf]
