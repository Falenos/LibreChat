import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ExtendedFile } from '~/common';
import KnaufKnowledgeFileList from './KnaufKnowledgeFileList';

// [knauf] KK20-227 seam test — a saved knowledge file with a retained session
// blob exposes a Re-index action that runs the server delete then re-uploads the
// blob (fresh RAG/OCR pass). Files without a retained blob show no re-index.

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

describe('KnaufKnowledgeFileList — KK20-227 in-session re-index', () => {
  it('re-indexes a saved file: server delete then re-upload of the retained blob', async () => {
    const blob = new File([new ArrayBuffer(8)], 'doc.pdf', { type: 'application/pdf' });
    const onReupload = jest.fn();
    const getReindexFile = jest.fn((file: ExtendedFile) =>
      file.file_id === 'f1' ? blob : undefined,
    );

    render(
      <KnaufKnowledgeFileList
        {...baseProps}
        files={new Map([['f1', savedFile]])}
        getReindexFile={getReindexFile}
        onReupload={onReupload}
      />,
    );

    const reindexButton = screen.getByLabelText('com_knauf_knowledge_reindex');
    fireEvent.click(reindexButton);

    await waitFor(() => expect(onReupload).toHaveBeenCalledWith(blob));
    // Delete ran (server-confirmed) before the re-upload.
    expect(mockDeleteMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockDeleteMutateAsync.mock.invocationCallOrder[0]).toBeLessThan(
      onReupload.mock.invocationCallOrder[0],
    );
  });

  it('does not re-upload when the server delete fails', async () => {
    mockDeleteMutateAsync.mockRejectedValueOnce(new Error('delete failed'));
    const blob = new File([new ArrayBuffer(8)], 'doc.pdf', { type: 'application/pdf' });
    const onReupload = jest.fn();
    const getReindexFile = jest.fn((file: ExtendedFile) =>
      file.file_id === 'f1' ? blob : undefined,
    );

    render(
      <KnaufKnowledgeFileList
        {...baseProps}
        files={new Map([['f1', savedFile]])}
        getReindexFile={getReindexFile}
        onReupload={onReupload}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText('com_knauf_knowledge_reindex'));
    });

    // Delete was attempted and failed → the retained blob is NOT re-uploaded
    // (re-uploading identical content would dedup-hit the still-present asset).
    expect(mockDeleteMutateAsync).toHaveBeenCalledTimes(1);
    expect(onReupload).not.toHaveBeenCalled();
  });

  it('shows no re-index action when no session blob is retained', () => {
    const onReupload = jest.fn();
    render(
      <KnaufKnowledgeFileList
        {...baseProps}
        files={new Map([['f1', savedFile]])}
        getReindexFile={() => undefined}
        onReupload={onReupload}
      />,
    );

    expect(screen.queryByLabelText('com_knauf_knowledge_reindex')).not.toBeInTheDocument();
  });
});
