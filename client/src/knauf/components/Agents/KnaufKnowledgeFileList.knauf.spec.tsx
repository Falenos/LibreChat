import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
// [knauf] KK20-195 WP5b — the list now uses useQueryClient (agent-files
// refetch after an indexing retry), so renders need a QueryClientProvider.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
// End [knauf]
import type { ExtendedFile } from '~/common';
import KnaufKnowledgeFileList from './KnaufKnowledgeFileList';

// [knauf] KK20-195 WP5b — provider-wrapped render for every test below.
const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
// End [knauf]

// [knauf] Failed local uploads expose Retry; healthy saved files never expose
// the old destructive delete-and-re-upload action.

const mockDeleteMutateAsync = jest.fn(() => Promise.resolve());

jest.mock('~/data-provider', () => ({
  useDeleteFilesMutation: () => ({ mutateAsync: mockDeleteMutateAsync }),
}));

jest.mock('~/hooks', () => ({
  useDebounce: (value: unknown) => value,
  useLocalize: () => (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key,
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
  DropdownPopup: () => null,
  Input: (props: Record<string, unknown>) => <input {...props} />,
  Spinner: () => <span data-testid="spinner" />,
}));

jest.mock('@ariakit/react', () => ({
  MenuButton: (props: Record<string, unknown>) => <button {...props} />,
}));

jest.mock('~/utils', () => ({
  getFileType: () => ({ fill: '#123456', paths: () => null }),
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
  deletePreview: jest.fn(),
}));

const savedFile = {
  file_id: 'f1',
  filename: 'doc.pdf',
  type: 'application/pdf',
  size: 1024,
  progress: 1,
  embedded: true,
  filepath: '/files/f1',
  source: 'local',
} as unknown as ExtendedFile;

const baseProps = {
  setFiles: jest.fn(),
  agent_id: 'agent-1',
  pendingFiles: new Map(),
  onRemovePending: jest.fn(),
  onRetryPending: jest.fn(),
};

beforeEach(() => {
  mockDeleteMutateAsync.mockClear();
});

describe('KnaufKnowledgeFileList — failed-upload retry', () => {
  it('shows no retry action on a healthy saved file', () => {
    const blob = new File([new ArrayBuffer(8)], 'doc.pdf', { type: 'application/pdf' });
    const onRetryUpload = jest.fn();

    render(
      <KnaufKnowledgeFileList
        {...baseProps}
        files={new Map([['f1', savedFile]])}
        getRetryFile={() => blob}
        onRetryUpload={onRetryUpload}
      />,
    );

    expect(screen.queryByLabelText('com_knauf_knowledge_retry')).not.toBeInTheDocument();
  });

  it('shows no retry action when a failed placeholder lost its local File', () => {
    const failedFile = {
      ...savedFile,
      file_id: 'failed',
      progress: -1,
      filepath: undefined,
    } as unknown as ExtendedFile;

    render(
      <KnaufKnowledgeFileList
        {...baseProps}
        files={new Map([['failed', failedFile]])}
        getRetryFile={() => undefined}
        onRetryUpload={jest.fn()}
      />,
    );

    expect(screen.queryByLabelText('com_knauf_knowledge_retry')).not.toBeInTheDocument();
  });

  it('retries a failed upload without issuing a server delete', async () => {
    const blob = new File([new ArrayBuffer(8)], 'failed.pdf', { type: 'application/pdf' });
    const onRetryUpload = jest.fn();
    const failedFile = {
      ...savedFile,
      file_id: 'failed',
      filename: 'failed.pdf',
      file: blob,
      progress: -1,
      filepath: undefined,
    } as unknown as ExtendedFile;

    render(
      <KnaufKnowledgeFileList
        {...baseProps}
        files={new Map([['failed', failedFile]])}
        getRetryFile={() => blob}
        onRetryUpload={onRetryUpload}
      />,
    );

    fireEvent.click(screen.getByLabelText('com_knauf_knowledge_retry'));

    await waitFor(() => expect(onRetryUpload).toHaveBeenCalledWith(blob));
    expect(mockDeleteMutateAsync).not.toHaveBeenCalled();
  });
});
