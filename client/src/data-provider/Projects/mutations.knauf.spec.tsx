// [knauf] KK20-248 — project file mutation cache invalidation coverage.
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import { useDeleteProjectFileMutation } from './mutations';

jest.mock('recoil', () => ({
  useRecoilCallback: jest.fn(() => jest.fn()),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    conversationByIndex: jest.fn(),
    updateConversationSelector: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
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
});
// End [knauf]
