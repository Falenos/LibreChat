// [knauf] KK20-195 WP5b — seam test: the §6.3 batch summary polls the batch
// endpoint while a multi-file selection is still indexing, renders
// "ready/total" (+ failed count), and renders nothing / stops polling once
// the batch is terminal or no pending batch exists.
import { act, render, screen } from '@testing-library/react';
import type { KnaufFileIndexing } from '~/knauf/common/fileIndexing';
import type { ExtendedFile } from '~/common';
import { KNAUF_INDEX_POLL_MS } from '~/knauf/hooks/Files/useKnaufIndexStatus';
import { getBatchIndexStatus } from '~/knauf/data-provider/data-service';
import KnaufBatchIndexSummary from './KnaufBatchIndexSummary';

jest.mock('~/knauf/data-provider/data-service', () => ({
  getBatchIndexStatus: jest.fn(),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<number, string>) =>
    (
      ({
        com_knauf_file_indexing_batch_summary: '{{0}} of {{1}} files ready',
        com_knauf_file_indexing_batch_failed: '{{0}} failed',
      }) as Record<string, string>
    )[key]?.replace(/{{(\d+)}}/g, (_, i) => values?.[Number(i)] ?? '') ?? key,
}));

const mockedGet = getBatchIndexStatus as jest.MockedFunction<typeof getBatchIndexStatus>;

const indexing = (overrides: Partial<KnaufFileIndexing> = {}): KnaufFileIndexing => ({
  status: 'queued',
  ready: false,
  retryable: false,
  error_code: null,
  queued_at: null,
  ...overrides,
});

const file = (id: string, batchId?: string, ix?: KnaufFileIndexing): ExtendedFile =>
  ({
    file_id: id,
    size: 1,
    progress: 1,
    knauf_upload_batch_id: batchId,
    indexing: ix,
  }) as ExtendedFile;

const summary = (overrides: Record<string, unknown> = {}) => ({
  batch_id: 'b1',
  total: 4,
  terminal: false,
  counts: { uploading: 0, queued: 1, processing: 1, ready: 1, failed: 1 },
  failures: [],
  ...overrides,
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

test('renders ready/total + failed count while the batch is non-terminal', async () => {
  mockedGet.mockResolvedValue(summary());
  render(
    <KnaufBatchIndexSummary
      files={
        new Map([
          ['f1', file('f1', 'b1', indexing())],
          ['f2', file('f2', 'b1', indexing())],
        ])
      }
    />,
  );
  await flush();
  expect(mockedGet).toHaveBeenCalledWith('b1');
  expect(screen.getByText(/1 of 4 files ready/)).toBeInTheDocument();
  expect(screen.getByText(/1 failed/)).toBeInTheDocument();
});

test('stops polling and renders nothing once the batch is terminal', async () => {
  mockedGet.mockResolvedValue(
    summary({
      terminal: true,
      counts: { uploading: 0, queued: 0, processing: 0, ready: 4, failed: 0 },
    }),
  );
  render(<KnaufBatchIndexSummary files={new Map([['f1', file('f1', 'b1', indexing())]])} />);
  await flush();
  expect(screen.queryByTestId('knauf-batch-index-summary')).not.toBeInTheDocument();
  const callsAfterFirst = mockedGet.mock.calls.length;
  await act(async () => {
    jest.advanceTimersByTime(KNAUF_INDEX_POLL_MS * 3);
    await Promise.resolve();
  });
  expect(mockedGet.mock.calls.length).toBe(callsAfterFirst); // interval cleared
});

test('no pending batch (single files / all settled) → no request at all', async () => {
  render(
    <KnaufBatchIndexSummary
      files={
        new Map([
          ['single', file('single', undefined, indexing())], // no batch id
          ['done', file('done', 'b2', indexing({ status: 'ready', ready: true }))],
        ])
      }
    />,
  );
  await flush();
  expect(mockedGet).not.toHaveBeenCalled();
});
// End [knauf]
