// [knauf] KK20-195 — chat attachments expose the server's idempotent indexing retry.
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import type { ExtendedFile } from '~/common';
import { postRetryFileIndex } from '~/knauf/data-provider/data-service';
import KnaufChatFileIndexingStatus from './KnaufChatFileIndexingStatus';

const mockShowToast = jest.fn();

jest.mock('@librechat/client', () => ({
  Spinner: () => <span data-testid="spinner" />,
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    (
      ({
        com_knauf_file_indexing_failed: 'Indexing failed',
        com_knauf_file_indexing_retry: 'Retry indexing',
        com_knauf_file_indexing_retry_failed: "Couldn't restart indexing.",
        com_knauf_file_indexing_retry_started: 'Indexing restarted…',
      }) as Record<string, string>
    )[key] ?? key,
}));

jest.mock('~/knauf/data-provider/data-service', () => ({
  postRetryFileIndex: jest.fn(),
}));

const mockPostRetryFileIndex = postRetryFileIndex as jest.MockedFunction<typeof postRetryFileIndex>;

const failedFile: ExtendedFile = {
  file_id: 'file-1',
  filename: 'knowledge.pdf',
  type: 'application/pdf',
  size: 1024,
  progress: 1,
  indexing: {
    status: 'failed',
    ready: false,
    retryable: true,
    error_code: 'rag_5xx',
    queued_at: null,
  },
};

function Harness() {
  const [files, setFiles] = useState(new Map([[failedFile.file_id, failedFile]]));
  const file = files.get(failedFile.file_id)!;
  return (
    <>
      <KnaufChatFileIndexingStatus file={file} setFiles={setFiles} />
      <span data-testid="index-status">{file.indexing?.status}</span>
    </>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('retries failed indexing and writes the queued projection into the chat file map', async () => {
  mockPostRetryFileIndex.mockResolvedValue({
    file_id: failedFile.file_id,
    indexing: { ...failedFile.indexing!, status: 'queued', retryable: false },
  });

  render(<Harness />);
  await userEvent.click(screen.getByLabelText('Retry indexing'));

  await waitFor(() => expect(screen.getByTestId('index-status')).toHaveTextContent('queued'));
  expect(mockPostRetryFileIndex).toHaveBeenCalledWith(failedFile.file_id);
  expect(mockShowToast).toHaveBeenCalledWith({
    message: 'Indexing restarted…',
    status: 'info',
  });
});

test('keeps the failed projection and reports a retry request failure', async () => {
  mockPostRetryFileIndex.mockRejectedValue(new Error('network'));

  render(<Harness />);
  await userEvent.click(screen.getByLabelText('Retry indexing'));

  await waitFor(() =>
    expect(mockShowToast).toHaveBeenCalledWith({
      message: "Couldn't restart indexing.",
      status: 'error',
    }),
  );
  expect(screen.getByTestId('index-status')).toHaveTextContent('failed');
});
// End [knauf]
