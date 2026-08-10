// [knauf] KK20-248 seam test — Project Knowledge files panel behavior.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryKeys } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import KnaufProjectFilesSection from './KnaufProjectFilesSection';

const mockUploadMutate = jest.fn();
const mockAddMutateAsync = jest.fn();
const mockDeleteMutate = jest.fn();
let mockProjectFiles: unknown[] = [];
let mockCapturedPreviewProps: Record<string, unknown> | null = null;
let mockUploadShouldResolve = true;
let mockUploadedFileCount = 0;

jest.mock('~/data-provider', () => ({
  useUploadFileMutation: (options: {
    onSuccess: (file: { file_id: string; filename: string; embedded?: boolean }, formData: FormData) => void;
  }) => ({
    isLoading: false,
    mutate: mockUploadMutate.mockImplementation((formData: FormData) => {
      if (mockUploadShouldResolve) {
        mockUploadedFileCount += 1;
        const uploadedName = (formData.get('file') as File).name;
        options.onSuccess(
          {
            file_id: `uploaded-file-${mockUploadedFileCount}`,
            filename: uploadedName,
            embedded: false,
          },
          formData,
        );
      }
      return formData;
    }),
  }),
}));

jest.mock('~/data-provider/Projects/mutations', () => ({
  useAddProjectFileMutation: () => ({ isLoading: false, mutateAsync: mockAddMutateAsync }),
  useDeleteProjectFileMutation: () => ({ isLoading: false, mutate: mockDeleteMutate }),
}));

jest.mock('~/data-provider/Projects/queries', () => ({
  useProjectFilesQuery: () => ({ data: { files: mockProjectFiles }, isLoading: false }),
}));

jest.mock('lucide-react', () => ({
  Eye: () => <svg data-testid="eye-icon" />,
  FileText: () => <svg data-testid="file-icon" />,
  Loader2: (props: { className?: string }) => <svg data-testid="progress-spinner" {...props} />,
  Trash2: () => <svg data-testid="trash-icon" />,
  Upload: () => <svg data-testid="upload-icon" />,
}));

jest.mock('~/components/Chat/Messages/Content/FilePreviewDialog', () =>
  function MockFilePreviewDialog(props: Record<string, unknown>) {
    mockCapturedPreviewProps = props;
    return props.open ? <div data-testid="project-file-preview">{String(props.fileName)}</div> : null;
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
      com_ui_upload_error: 'Upload error',
    })[key] ?? key,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

const renderWithClient = (ui: React.ReactElement, queryClient = new QueryClient()) =>
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

beforeEach(() => {
  mockProjectFiles = [];
  mockCapturedPreviewProps = null;
  mockUploadShouldResolve = true;
  mockUploadedFileCount = 0;
  mockUploadMutate.mockClear();
  mockAddMutateAsync.mockResolvedValue({});
  mockAddMutateAsync.mockClear();
  mockDeleteMutate.mockClear();
  let mockClientFileCount = 0;
  jest.spyOn(crypto, 'randomUUID').mockImplementation(() => {
    mockClientFileCount += 1;
    return `client-file-id-${mockClientFileCount}`;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('[knauf] KnaufProjectFilesSection', () => {
  it('uploads with message_file semantics and attaches the uploaded file to the project', async () => {
    renderWithClient(<KnaufProjectFilesSection projectId="project-1" />);

    fireEvent.change(screen.getByLabelText('Upload'), {
      target: { files: [new File(['hello'], 'doc.txt', { type: 'text/plain' })] },
    });

    expect(mockUploadMutate).toHaveBeenCalledTimes(1);
    const formData = mockUploadMutate.mock.calls[0][0] as FormData;
    expect(formData.get('file_id')).toBe('client-file-id-1');
    expect(formData.get('message_file')).toBe('true');
    expect(formData.get('tool_resource')).toBe('file_search');

    await waitFor(() =>
      expect(mockAddMutateAsync).toHaveBeenCalledWith({
        projectId: 'project-1',
        file_id: 'uploaded-file-1',
        status: 'processing',
      }),
    );
  });

  it('uploads all selected files from the picker', async () => {
    renderWithClient(<KnaufProjectFilesSection projectId="project-1" />);

    fireEvent.change(screen.getByLabelText('Upload'), {
      target: {
        files: [
          new File(['hello'], 'doc-1.txt', { type: 'text/plain' }),
          new File(['world'], 'doc-2.txt', { type: 'text/plain' }),
        ],
      },
    });

    expect(mockUploadMutate).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(mockAddMutateAsync).toHaveBeenNthCalledWith(2, {
        projectId: 'project-1',
        file_id: 'uploaded-file-2',
        status: 'processing',
      }),
    );
  });

  it('uploads dropped files with the same project attach flow', async () => {
    renderWithClient(<KnaufProjectFilesSection projectId="project-1" />);

    fireEvent.drop(screen.getByText('Files').closest('section') as HTMLElement, {
      dataTransfer: {
        files: [new File(['hello'], 'dropped.txt', { type: 'text/plain' })],
      },
    });

    expect(mockUploadMutate).toHaveBeenCalledTimes(1);
    const formData = mockUploadMutate.mock.calls[0][0] as FormData;
    expect((formData.get('file') as File).name).toBe('dropped.txt');
    await waitFor(() =>
      expect(mockAddMutateAsync).toHaveBeenCalledWith({
        projectId: 'project-1',
        file_id: 'uploaded-file-1',
        status: 'processing',
      }),
    );
  });

  it('adds uploaded project files to the global files cache for the left rail', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData<TFile[]>([QueryKeys.files], [
      { file_id: 'existing-file', filename: 'existing.txt' } as TFile,
    ]);
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderWithClient(<KnaufProjectFilesSection projectId="project-1" />, queryClient);

    fireEvent.change(screen.getByLabelText('Upload'), {
      target: { files: [new File(['hello'], 'doc.txt', { type: 'text/plain' })] },
    });

    await waitFor(() => expect(mockAddMutateAsync).toHaveBeenCalled());
    expect(queryClient.getQueryData<TFile[]>([QueryKeys.files])).toEqual([
      expect.objectContaining({ file_id: 'uploaded-file-1', filename: 'doc.txt' }),
      expect.objectContaining({ file_id: 'existing-file' }),
    ]);
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.files]);
  });

  it('hydrates existing attached project files into the global files cache for the left rail', async () => {
    mockProjectFiles = [
      { projectId: 'project-1', file_id: 'project-file-1', filename: 'one.pdf', status: 'ready' },
      { projectId: 'project-1', file_id: 'project-file-2', filename: 'two.pdf', status: 'ready' },
    ];
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData<TFile[]>([QueryKeys.files], [
      { file_id: 'existing-file', filename: 'existing.txt' } as TFile,
    ]);

    renderWithClient(<KnaufProjectFilesSection projectId="project-1" />, queryClient);

    await waitFor(() =>
      expect(queryClient.getQueryData<TFile[]>([QueryKeys.files])).toEqual([
        expect.objectContaining({ file_id: 'project-file-1', filename: 'one.pdf' }),
        expect.objectContaining({ file_id: 'project-file-2', filename: 'two.pdf' }),
        expect.objectContaining({ file_id: 'existing-file' }),
      ]),
    );
  });

  it('does not hydrate failed project file associations into the global files cache', async () => {
    mockProjectFiles = [
      { projectId: 'project-1', file_id: 'orphan-file', filename: '', status: 'failed' },
    ];
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    renderWithClient(<KnaufProjectFilesSection projectId="project-1" />, queryClient);

    await waitFor(() => expect(screen.getByText('orphan-file')).toBeInTheDocument());
    expect(queryClient.getQueryData<TFile[]>([QueryKeys.files])).toEqual([]);
  });

  it('falls back to file_id when a project file name is missing', async () => {
    mockProjectFiles = [
      { projectId: 'project-1', file_id: 'project-file-1', filename: '', status: 'ready' },
    ];
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    renderWithClient(<KnaufProjectFilesSection projectId="project-1" />, queryClient);

    await waitFor(() =>
      expect(queryClient.getQueryData<TFile[]>([QueryKeys.files])).toEqual([
        expect.objectContaining({ file_id: 'project-file-1', filename: 'project-file-1' }),
      ]),
    );
  });

  it('shows an uploading row immediately while upload is in flight', () => {
    mockUploadShouldResolve = false;
    renderWithClient(<KnaufProjectFilesSection projectId="project-1" />);

    fireEvent.change(screen.getByLabelText('Upload'), {
      target: { files: [new File(['hello'], 'doc.txt', { type: 'text/plain' })] },
    });

    expect(screen.getByText('doc.txt')).toBeInTheDocument();
    expect(screen.getByText('uploading')).toBeInTheDocument();
    expect(screen.getByTestId('progress-spinner')).toHaveClass('animate-spin');
    expect(screen.getByLabelText('Preview')).toBeDisabled();
  });

  it('keeps the pending row visible until the refetched server row is available', async () => {
    const queryClient = new QueryClient();
    const { rerender } = renderWithClient(<KnaufProjectFilesSection projectId="project-1" />, queryClient);

    fireEvent.change(screen.getByLabelText('Upload'), {
      target: { files: [new File(['hello'], 'doc.txt', { type: 'text/plain' })] },
    });

    await waitFor(() => expect(mockAddMutateAsync).toHaveBeenCalled());
    expect(screen.getByText('doc.txt')).toBeInTheDocument();
    expect(screen.queryByText('No results found')).not.toBeInTheDocument();

    mockProjectFiles = [
      {
        projectId: 'project-1',
        file_id: 'uploaded-file-1',
        filename: 'doc.txt',
        status: 'processing',
      },
    ];
    await act(async () => {
      rerender(
        <QueryClientProvider client={queryClient}>
          <KnaufProjectFilesSection projectId="project-1" />
        </QueryClientProvider>,
      );
    });

    expect(screen.getByText('doc.txt')).toBeInTheDocument();
    expect(screen.getByText('processing')).toBeInTheDocument();
  });

  it('enables preview for ready files and passes project-scoped preview props', async () => {
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
    await fireEvent.click(screen.getByLabelText('Preview'));

    expect(screen.getByTestId('project-file-preview')).toHaveTextContent('ready.pdf');
    expect(mockCapturedPreviewProps).toMatchObject({
      open: true,
      fileId: 'ready-file',
      fileName: 'ready.pdf',
      fileType: 'application/pdf',
      fileSize: 123,
      projectId: 'project-1',
    });
  });

  it('disables preview for non-ready files', () => {
    mockProjectFiles = [
      {
        projectId: 'project-1',
        file_id: 'processing-file',
        filename: 'processing.pdf',
        status: 'processing',
      },
    ];

    renderWithClient(<KnaufProjectFilesSection projectId="project-1" />);

    expect(screen.getByLabelText('Preview')).toBeDisabled();
  });

  it('deletes the project file association', () => {
    mockProjectFiles = [
      {
        projectId: 'project-1',
        file_id: 'ready-file',
        filename: 'ready.pdf',
        status: 'ready',
      },
    ];

    renderWithClient(<KnaufProjectFilesSection projectId="project-1" />);
    fireEvent.click(screen.getByLabelText('Delete'));

    expect(mockDeleteMutate).toHaveBeenCalledWith({ projectId: 'project-1', file_id: 'ready-file' });
  });
});
// End [knauf]
