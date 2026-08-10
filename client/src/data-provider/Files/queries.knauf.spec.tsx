// [knauf] KK20-221 seam test — useFileDownload must consume React Query's
// AbortSignal and forward it to dataService.getFileDownload, so that closing the
// preview dialog (queryClient.cancelQueries) aborts the in-flight blob request.
// Removing the `{ signal }` destructure or the forwarded arg breaks cancellation.
import React from 'react';
import { dataService } from 'librechat-data-provider';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFileDownload } from './queries';
// End [knauf]

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getFileDownload: jest.fn(() => Promise.resolve({ data: new Blob(), headers: {} })),
      getProjectFileDownload: jest.fn(() => Promise.resolve({ data: new Blob(), headers: {} })),
    },
  };
});

const mockGetFileDownload = dataService.getFileDownload as jest.Mock;
const mockGetProjectFileDownload = dataService.getProjectFileDownload as jest.Mock;

const createWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

beforeAll(() => {
  // jsdom does not implement createObjectURL; the download query fn calls it.
  global.URL.createObjectURL = jest.fn(() => 'blob:mock');
});

beforeEach(() => {
  mockGetFileDownload.mockClear();
  mockGetProjectFileDownload.mockClear();
});

describe('[knauf] KK20-221 — useFileDownload AbortSignal', () => {
  it('forwards an AbortSignal as the third arg to getFileDownload', async () => {
    const { result } = renderHook(() => useFileDownload('user-1', 'file-1', { direct: false }), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.refetch();
    });

    expect(mockGetFileDownload).toHaveBeenCalled();
    const [userId, fileId, signal] = mockGetFileDownload.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(fileId).toBe('file-1');
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the project-scoped download route when projectId is provided', async () => {
    const { result } = renderHook(
      () => useFileDownload(undefined, 'file-1', { direct: false, projectId: 'project-1' }),
      { wrapper: createWrapper() },
    );

    await act(async () => {
      await result.current.refetch();
    });

    expect(mockGetProjectFileDownload).toHaveBeenCalled();
    const [projectId, fileId, signal] = mockGetProjectFileDownload.mock.calls[0];
    expect(projectId).toBe('project-1');
    expect(fileId).toBe('file-1');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(mockGetFileDownload).not.toHaveBeenCalled();
  });
});
