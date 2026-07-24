// [knauf] Agent-wide knowledge summary: explicit nonzero ready/processing/failed
// counts from the rows visible in the builder; no batch switching or polling.
import { render, screen } from '@testing-library/react';
import type { KnaufFileIndexing } from '~/knauf/common/fileIndexing';
import type { ExtendedFile } from '~/common';
import KnaufBatchIndexSummary from './KnaufBatchIndexSummary';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<number, string>) =>
    (
      ({
        com_knauf_file_indexing_files_total: 'Files: {{0}}',
        com_knauf_file_indexing_ready_count: 'Ready: {{0}}',
        com_knauf_file_indexing_processing_count: 'Processing: {{0}}',
        com_knauf_file_indexing_failed_count: 'Failed: {{0}}',
      }) as Record<string, string>
    )[key]?.replace(/{{(\d+)}}/g, (_, i) => values?.[Number(i)] ?? '') ?? key,
}));

const indexing = (overrides: Partial<KnaufFileIndexing> = {}): KnaufFileIndexing => ({
  status: 'queued',
  ready: false,
  retryable: false,
  error_code: null,
  queued_at: null,
  ...overrides,
});

const file = (id: string, progress = 1, ix?: KnaufFileIndexing): ExtendedFile =>
  ({
    file_id: id,
    size: 1,
    progress,
    indexing: ix,
  }) as ExtendedFile;

test('renders agent-wide nonzero ready, processing, and failed counts', () => {
  render(
    <KnaufBatchIndexSummary
      files={
        new Map([
          ['ready', file('ready', 1, indexing({ status: 'ready', ready: true }))],
          ['indexing', file('indexing', 1, indexing({ status: 'processing' }))],
          ['upload-failed', file('upload-failed', -1)],
          ['index-failed', file('index-failed', 1, indexing({ status: 'failed' }))],
        ])
      }
      pendingFiles={
        new Map([
          ['queued', { status: 'queued' }],
          ['pending-failed', { status: 'error' }],
        ])
      }
    />,
  );
  expect(screen.getByText('Files: 6')).toBeInTheDocument();
  expect(screen.getByText(/Ready: 1/)).toBeInTheDocument();
  expect(screen.getByText(/Processing: 2/)).toBeInTheDocument();
  expect(screen.getByText(/Failed: 3/)).toBeInTheDocument();
});

test('omits zero-value states', () => {
  render(
    <KnaufBatchIndexSummary
      files={
        new Map([
          ['f1', file('f1')],
          ['f2', file('f2', 1, indexing({ status: 'ready', ready: true }))],
        ])
      }
      pendingFiles={new Map()}
    />,
  );
  expect(screen.getByText('Files: 2')).toBeInTheDocument();
  expect(screen.getByText(/Ready: 2/)).toBeInTheDocument();
  expect(screen.queryByText(/Processing:/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Failed:/)).not.toBeInTheDocument();
});

test('renders nothing for an empty agent library', () => {
  render(<KnaufBatchIndexSummary files={new Map()} pendingFiles={new Map()} />);
  expect(screen.queryByTestId('knauf-batch-index-summary')).not.toBeInTheDocument();
});
// End [knauf]
