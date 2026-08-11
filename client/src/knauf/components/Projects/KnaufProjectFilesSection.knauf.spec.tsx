// [knauf] KK20-248 seam test — project uploads reuse the agent upload engine.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EModelEndpoint, EToolResources, QueryKeys } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { postRetryFileIndex } from '~/knauf/data-provider/data-service';
import KnaufProjectFilesSection from './KnaufProjectFilesSection';

const mockHandleFileChange = jest.fn();
const mockHandleFiles = jest.fn();
const mockHandleSharePointFiles = jest.fn();
const mockAddMutateAsync = jest.fn();
const mockDeleteMutate = jest.fn();
const mockShowToast = jest.fn();
const mockPostRetryFileIndex = postRetryFileIndex as jest.MockedFunction<typeof postRetryFileIndex>;
let mockProjectFiles: Array<Record<string, unknown>> = [];
let mockStartupConfig: Record<string, unknown> = {};
let capturedLocalOptions: Record<string, any>;
let capturedSharePointOptions: Record<string, any>;
let capturedFileState: {
  files: Map<string, ExtendedFile>;
  setFiles: React.Dispatch<React.SetStateAction<Map<string, ExtendedFile>>>;
};
let capturedPreviewProps: Record<string, unknown> | null = null;
let capturedSharePointProps: Record<string, any> | null = null;

jest.mock('@ariakit/react', () => ({
  MenuButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock('@librechat/client', () => ({
  DropdownPopup: ({ trigger, items }: { trigger: React.ReactNode; items: any[] }) => (
    <div>
      {trigger}
      {items.map((item) => (
        <button key={item.label} type="button" onClick={item.onClick}>
          {item.label}
        </button>
      ))}
    </div>
  ),
  SharePointIcon: () => <svg data-testid="sharepoint-icon" />,
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
}));

jest.mock('~/hooks/Files/useFileHandling', () => ({
  useFileHandlingNoChatContext: (options: Record<string, any>, state: typeof capturedFileState) => {
    capturedLocalOptions = options;
    capturedFileState = state;
    return { handleFileChange: mockHandleFileChange, handleFiles: mockHandleFiles };
  },
}));

jest.mock('~/hooks/Files/useSharePointFileHandling', () => ({
  useSharePointFileHandlingNoChatContext: (
    options: Record<string, any>,
    state: typeof capturedFileState,
  ) => {
    capturedSharePointOptions = options;
    capturedFileState = state;
    return {
      handleSharePointFiles: mockHandleSharePointFiles,
      isProcessing: false,
      downloadProgress: null,
    };
  },
}));

jest.mock('~/data-provider/Projects/mutations', () => ({
  useAddProjectFileMutation: () => ({ isLoading: false, mutateAsync: mockAddMutateAsync }),
  useDeleteProjectFileMutation: () => ({ isLoading: false, mutate: mockDeleteMutate }),
}));

jest.mock('~/data-provider/Projects/queries', () => ({
  useProjectFilesQuery: () => ({ data: { files: mockProjectFiles }, isLoading: false }),
}));

jest.mock('~/knauf/data-provider/data-service', () => ({
  postRetryFileIndex: jest.fn(),
}));

jest.mock(
  '~/knauf/components/Files/KnaufFileIndexingStatus',
  () =>
    function MockIndexingStatus({
      indexing,
      onRetry,
    }: {
      indexing?: { status?: string };
      onRetry?: () => void;
    }) {
      if (indexing?.status === 'failed') {
        return (
          <button type="button" data-testid="retry-indexing" onClick={onRetry}>
            {indexing.status}
          </button>
        );
      }
      return indexing != null ? <span>{indexing.status}</span> : null;
    },
);

jest.mock('~/components/SharePoint', () => ({
  SharePointPickerDialog: (props: Record<string, any>) => {
    capturedSharePointProps = props;
    return props.isOpen ? <div data-testid="sharepoint-picker" /> : null;
  },
}));

jest.mock(
  '~/components/Chat/Messages/Content/FilePreviewDialog',
  () =>
    function MockFilePreviewDialog(props: Record<string, unknown>) {
      capturedPreviewProps = props;
      return props.open ? (
        <div data-testid="project-file-preview">{String(props.fileName)}</div>
      ) : null;
    },
);

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    ({
      com_ui_files: 'Files',
      com_ui_upload_files: 'Upload files',
      com_ui_upload: 'Upload',
      com_ui_no_results_found: 'No results found',
      com_ui_loading: 'Loading',
      com_ui_preview: 'Preview',
      com_ui_delete: 'Delete',
      com_ui_retry: 'Retry',
      com_files_upload_local_machine: 'Local Computer',
      com_files_upload_sharepoint: 'SharePoint',
      com_knauf_file_indexing_retry_started: 'Indexing restarted',
      com_knauf_file_indexing_retry_failed: 'Indexing retry failed',
    })[key] ?? key,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

const renderWithClient = (ui: React.ReactElement, queryClient = new QueryClient()) => ({
  queryClient,
  ...render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>),
});

beforeEach(() => {
  mockProjectFiles = [];
  mockStartupConfig = {};
  capturedPreviewProps = null;
  capturedSharePointProps = null;
  mockHandleFileChange.mockReset();
  mockHandleFiles.mockReset().mockResolvedValue(undefined);
  mockHandleSharePointFiles.mockReset().mockResolvedValue(undefined);
  mockAddMutateAsync.mockReset().mockResolvedValue({});
  mockDeleteMutate.mockReset();
  mockShowToast.mockReset();
  mockPostRetryFileIndex.mockReset();
});

describe('[knauf] KnaufProjectFilesSection', () => {
  it('wires project association into the shared agent upload engine', async () => {
    const { queryClient } = renderWithClient(
      <KnaufProjectFilesSection projectId="project-1" />,
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    queryClient.setQueryData<TFile[]>(
      [QueryKeys.files],
      [{ file_id: 'existing-file', filename: 'existing.txt' } as TFile],
    );

    expect(capturedLocalOptions).toMatchObject({
      endpointOverride: EModelEndpoint.agents,
      endpointTypeOverride: EModelEndpoint.agents,
      additionalMetadata: { tool_resource: EToolResources.file_search },
    });
    expect(capturedSharePointOptions.onUploadSuccess).toBe(capturedLocalOptions.onUploadSuccess);

    await act(async () => {
      await capturedLocalOptions.onUploadSuccess({
        file_id: 'uploaded-file',
        temp_file_id: 'temp-file',
        filename: 'doc.txt',
        embedded: false,
      });
    });

    expect(mockAddMutateAsync).toHaveBeenCalledWith({
      projectId: 'project-1',
      file_id: 'uploaded-file',
      status: 'processing',
    });
    expect(queryClient.getQueryData<TFile[]>([QueryKeys.files])).toEqual([
      expect.objectContaining({ file_id: 'uploaded-file', filename: 'doc.txt' }),
      expect.objectContaining({ file_id: 'existing-file' }),
    ]);
  });

  it('delegates picker and dropped files to the same shared handlers', () => {
    const { container } = renderWithClient(<KnaufProjectFilesSection projectId="project-1" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const picked = new File(['picked'], 'picked.pdf', { type: 'application/pdf' });
    const dropped = new File(['dropped'], 'dropped.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [picked] } });
    expect(mockHandleFileChange).toHaveBeenCalledWith(expect.any(Object));

    fireEvent.drop(screen.getByText('Files').closest('section') as HTMLElement, {
      dataTransfer: { files: [dropped] },
    });
    expect(mockHandleFiles).toHaveBeenCalledWith([dropped]);
  });

  it('renders shared progress and retries a retained failed File through the shared handler', async () => {
    renderWithClient(<KnaufProjectFilesSection projectId="project-1" />);
    const original = new File(['hello'], 'retry.pdf', { type: 'application/pdf' });

    act(() => {
      capturedFileState.setFiles(
        new Map([
          [
            'temp-file',
            {
              file_id: 'temp-file',
              file: original,
              filename: original.name,
              type: original.type,
              size: original.size,
              progress: -1,
            },
          ],
        ]),
      );
    });

    expect(screen.getByText('retry.pdf')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Retry'));

    await waitFor(() => expect(mockHandleFiles).toHaveBeenCalledWith([original]));
  });

  it('routes SharePoint selections through the shared SharePoint handler', async () => {
    mockStartupConfig = { sharePointFilePickerEnabled: true };
    renderWithClient(<KnaufProjectFilesSection projectId="project-1" />);

    fireEvent.click(screen.getByText('SharePoint'));
    expect(screen.getByTestId('sharepoint-picker')).toBeInTheDocument();
    const selected = [{ id: 'sharepoint-file' }];
    await act(async () => {
      await capturedSharePointProps?.onFilesSelected(selected);
    });

    expect(mockHandleSharePointFiles).toHaveBeenCalledWith(selected);
    expect(screen.queryByTestId('sharepoint-picker')).not.toBeInTheDocument();
  });

  it('hydrates existing attached project files into the global files cache', async () => {
    mockProjectFiles = [
      { projectId: 'project-1', file_id: 'project-file', filename: 'one.pdf', status: 'ready' },
    ];
    const { queryClient } = renderWithClient(<KnaufProjectFilesSection projectId="project-1" />);

    await waitFor(() =>
      expect(queryClient.getQueryData<TFile[]>([QueryKeys.files])).toEqual([
        expect.objectContaining({ file_id: 'project-file', filename: 'one.pdf' }),
      ]),
    );
    expect(capturedFileState.files.get('project-file')).toEqual(
      expect.objectContaining({ attached: true, progress: 1, filename: 'one.pdf' }),
    );
  });

  it('retries failed indexing and updates the project polling cache immediately', async () => {
    mockProjectFiles = [
      {
        projectId: 'project-1',
        file_id: 'failed-file',
        filename: 'failed.pdf',
        status: 'failed',
        indexing: { status: 'failed', ready: false, retryable: true },
      },
    ];
    mockPostRetryFileIndex.mockResolvedValue({
      file_id: 'failed-file',
      indexing: {
        status: 'queued',
        ready: false,
        retryable: false,
        error_code: null,
        queued_at: '2026-08-11T00:00:00.000Z',
      },
    });
    const { queryClient } = renderWithClient(<KnaufProjectFilesSection projectId="project-1" />);
    queryClient.setQueryData([QueryKeys.projectFiles, 'project-1'], { files: mockProjectFiles });

    fireEvent.click(screen.getByTestId('retry-indexing'));

    await waitFor(() => expect(mockPostRetryFileIndex).toHaveBeenCalledWith('failed-file'));
    expect(queryClient.getQueryData<any>([QueryKeys.projectFiles, 'project-1'])).toEqual({
      files: [
        expect.objectContaining({
          status: 'processing',
          indexing: expect.objectContaining({ status: 'queued' }),
        }),
      ],
    });
    expect(mockShowToast).toHaveBeenCalledWith({ message: 'Indexing restarted', status: 'info' });
  });

  it('previews ready files and deletes only their project association', () => {
    mockProjectFiles = [
      {
        projectId: 'project-1',
        file_id: 'ready-file',
        filename: 'ready.pdf',
        type: 'application/pdf',
        bytes: 123,
        status: 'ready',
      },
    ];
    renderWithClient(<KnaufProjectFilesSection projectId="project-1" />);

    fireEvent.click(screen.getByLabelText('Preview'));
    expect(screen.getByTestId('project-file-preview')).toHaveTextContent('ready.pdf');
    expect(capturedPreviewProps).toMatchObject({
      fileId: 'ready-file',
      fileType: 'application/pdf',
      fileSize: 123,
      projectId: 'project-1',
    });

    fireEvent.click(screen.getByLabelText('Delete'));
    expect(mockDeleteMutate).toHaveBeenCalledWith({
      projectId: 'project-1',
      file_id: 'ready-file',
    });
  });
});
// End [knauf]
