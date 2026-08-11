// [knauf] KK20-248 — deleting from the library must also evict matching project-file cache rows.
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { TChatProjectFilesResponse, TFile } from 'librechat-data-provider';
import { useDeleteFilesMutation, useUploadFileMutation } from './mutations';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      deleteFiles: jest.fn(),
      uploadFile: jest.fn(),
    },
  };
});

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

describe('file upload mutations [knauf]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('awaits an asynchronous target callback before settling the mutation', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    let releaseAssociation!: () => void;
    const association = new Promise<void>((resolve) => {
      releaseAssociation = resolve;
    });
    const onSuccess = jest.fn(() => association);
    (dataService.uploadFile as jest.Mock).mockResolvedValue({
      file_id: 'project-file',
      temp_file_id: 'temp-file',
      filename: 'project.pdf',
    });
    const formData = new FormData();
    formData.append('endpoint', 'agents');
    formData.append('message_file', 'true');

    const { result } = renderHook(() => useUploadFileMutation({ onSuccess }), {
      wrapper: createWrapper(queryClient),
    });
    let settled = false;
    const mutation = result.current.mutateAsync(formData).finally(() => {
      settled = true;
    });

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(settled).toBe(false);

    await act(async () => {
      releaseAssociation();
      await mutation;
    });
    expect(settled).toBe(true);
  });

  it('keeps the global file cache idempotent when target association retries the upload', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const uploadedFile = {
      file_id: 'project-file',
      temp_file_id: 'temp-file',
      filename: 'project.pdf',
    };
    (dataService.uploadFile as jest.Mock).mockResolvedValue(uploadedFile);
    const formData = new FormData();
    formData.append('endpoint', 'agents');
    formData.append('message_file', 'true');
    const { result } = renderHook(() => useUploadFileMutation({ onSuccess: jest.fn() }), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync(formData);
      await result.current.mutateAsync(formData);
    });

    expect(queryClient.getQueryData<TFile[]>([QueryKeys.files])).toEqual([uploadedFile]);
  });
});

describe('file delete mutations [knauf]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('removes deleted library files from cached project file lists too', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData<TFile[]>(
      [QueryKeys.files],
      [
        { file_id: 'file-1', filename: 'delete-me.txt' } as TFile,
        { file_id: 'file-2', filename: 'keep.txt' } as TFile,
      ],
    );
    queryClient.setQueryData<TChatProjectFilesResponse>([QueryKeys.projectFiles, 'project-1'], {
      files: [
        {
          projectId: 'project-1',
          file_id: 'file-1',
          sourceType: 'file',
          user: 'u1',
          status: 'ready',
        },
        {
          projectId: 'project-1',
          file_id: 'file-2',
          sourceType: 'file',
          user: 'u1',
          status: 'ready',
        },
      ],
    });
    queryClient.setQueryData<TChatProjectFilesResponse>([QueryKeys.projectFiles, 'project-2'], {
      files: [
        {
          projectId: 'project-2',
          file_id: 'file-1',
          sourceType: 'file',
          user: 'u1',
          status: 'ready',
        },
      ],
    });
    (dataService.deleteFiles as jest.Mock).mockResolvedValue({
      message: 'Files deleted successfully',
    });

    const { result } = renderHook(() => useDeleteFilesMutation(), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate({
      files: [
        {
          file_id: 'file-1',
          filepath: '/uploads/file-1.txt',
          embedded: true,
          source: 'local' as any,
        },
      ],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData<TFile[]>([QueryKeys.files])).toEqual([
      expect.objectContaining({ file_id: 'file-2' }),
    ]);
    expect(
      queryClient.getQueryData<TChatProjectFilesResponse>([QueryKeys.projectFiles, 'project-1']),
    ).toEqual({ files: [expect.objectContaining({ file_id: 'file-2' })] });
    expect(
      queryClient.getQueryData<TChatProjectFilesResponse>([QueryKeys.projectFiles, 'project-2']),
    ).toEqual({ files: [] });
  });
});
// End [knauf]
