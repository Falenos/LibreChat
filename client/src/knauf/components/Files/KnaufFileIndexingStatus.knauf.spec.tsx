// [knauf] KK20-195 WP5b — seam test: the per-row indexing state renders a
// pending spinner, a failed label with retry ONLY when the server marked the
// asset retryable, and nothing for ready/legacy rows.
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import type { KnaufFileIndexing } from '~/knauf/common/fileIndexing';
import KnaufFileIndexingStatus from './KnaufFileIndexingStatus';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    (
      ({
        com_knauf_file_indexing_pending: 'Indexing…',
        com_knauf_file_indexing_failed: 'Indexing failed',
        com_knauf_file_indexing_retry: 'Retry indexing',
      }) as Record<string, string>
    )[key] ?? key,
}));

const indexing = (overrides: Partial<KnaufFileIndexing>): KnaufFileIndexing => ({
  status: 'queued',
  ready: false,
  retryable: false,
  error_code: null,
  queued_at: null,
  ...overrides,
});

test('pending → spinner + label', () => {
  render(<KnaufFileIndexingStatus indexing={indexing({ status: 'processing' })} />);
  expect(screen.getByText('Indexing…')).toBeInTheDocument();
});

test('failed + retryable → label + retry action', async () => {
  const onRetry = jest.fn();
  render(
    <KnaufFileIndexingStatus
      indexing={indexing({ status: 'failed', retryable: true, error_code: 'rag_5xx' })}
      onRetry={onRetry}
    />,
  );
  expect(screen.getByText('Indexing failed')).toBeInTheDocument();
  await userEvent.click(screen.getByLabelText('Retry indexing'));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('failed but NOT retryable → label only, no retry button', () => {
  render(
    <KnaufFileIndexingStatus
      indexing={indexing({
        status: 'failed',
        retryable: false,
        error_code: 'file_reupload_required',
      })}
      onRetry={jest.fn()}
    />,
  );
  expect(screen.getByText('Indexing failed')).toBeInTheDocument();
  expect(screen.queryByLabelText('Retry indexing')).not.toBeInTheDocument();
});

test('ready and legacy (no projection) render nothing', () => {
  const { container: ready } = render(
    <KnaufFileIndexingStatus indexing={indexing({ status: 'ready', ready: true })} />,
  );
  expect(ready).toBeEmptyDOMElement();
  const { container: legacy } = render(<KnaufFileIndexingStatus />);
  expect(legacy).toBeEmptyDOMElement();
});
// End [knauf]
