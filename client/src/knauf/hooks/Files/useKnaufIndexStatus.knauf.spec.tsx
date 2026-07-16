// [knauf] KK20-195 WP5a — seam test: the poll loop fetches pending files
// every 5s, writes the projection back through the Map setter (flipping
// `embedded` on ready), survives fetch failures, and STOPS once every file
// is terminal (plan §6.5: no polling at rest).
import { renderHook, act } from '@testing-library/react';
import type { KnaufFileIndexing } from '~/knauf/common/fileIndexing';
import type { ExtendedFile } from '~/common';
import useKnaufIndexStatus, { KNAUF_INDEX_POLL_MS } from './useKnaufIndexStatus';
import { getFileIndexStatus } from '~/knauf/data-provider/data-service';

jest.mock('~/knauf/data-provider/data-service', () => ({
  getFileIndexStatus: jest.fn(),
}));

const mockedGet = getFileIndexStatus as jest.MockedFunction<typeof getFileIndexStatus>;

const indexing = (overrides: Partial<KnaufFileIndexing> = {}): KnaufFileIndexing => ({
  status: 'queued',
  ready: false,
  retryable: false,
  error_code: null,
  queued_at: null,
  ...overrides,
});

const file = (id: string, ix?: KnaufFileIndexing, progress = 1): ExtendedFile =>
  ({ file_id: id, size: 1, progress, indexing: ix }) as ExtendedFile;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

const advanceOneTick = async () => {
  await act(async () => {
    jest.advanceTimersByTime(KNAUF_INDEX_POLL_MS);
    // flush the async tick (Promise.all + setter)
    await Promise.resolve();
    await Promise.resolve();
  });
};

test('polls pending files and writes ready back through the setter (embedded flips)', async () => {
  let filesMap = new Map<string, ExtendedFile>([
    ['pending-1', file('pending-1', indexing())],
    ['legacy-1', file('legacy-1')],
  ]);
  const setFiles = jest.fn((updater) => {
    filesMap = typeof updater === 'function' ? updater(filesMap) : updater;
  });
  mockedGet.mockResolvedValue({
    file_id: 'pending-1',
    indexing: indexing({ status: 'ready', ready: true }),
  });

  const { rerender } = renderHook(({ files }) => useKnaufIndexStatus({ files, setFiles }), {
    initialProps: { files: filesMap },
  });

  await advanceOneTick();

  expect(mockedGet).toHaveBeenCalledTimes(1);
  expect(mockedGet).toHaveBeenCalledWith('pending-1'); // legacy file never polled
  const updated = filesMap.get('pending-1');
  expect(updated?.indexing?.ready).toBe(true);
  expect(updated?.embedded).toBe(true); // legacy flag agrees with the ledger

  // The updated map has no pending files left → the loop dis-arms.
  rerender({ files: filesMap });
  await advanceOneTick();
  expect(mockedGet).toHaveBeenCalledTimes(1); // no further calls
});

test('files still uploading (progress < 1) are not polled yet', async () => {
  const filesMap = new Map<string, ExtendedFile>([
    ['uploading', file('uploading', indexing(), 0.4)],
  ]);
  renderHook(() => useKnaufIndexStatus({ files: filesMap, setFiles: jest.fn() }));
  await advanceOneTick();
  expect(mockedGet).not.toHaveBeenCalled();
});

test('a fetch failure leaves the entry untouched and the loop keeps polling', async () => {
  let filesMap = new Map<string, ExtendedFile>([['p1', file('p1', indexing())]]);
  const setFiles = jest.fn((updater) => {
    filesMap = typeof updater === 'function' ? updater(filesMap) : updater;
  });
  mockedGet.mockRejectedValueOnce(new Error('network'));
  mockedGet.mockResolvedValueOnce({
    file_id: 'p1',
    indexing: indexing({ status: 'failed', retryable: true, error_code: 'rag_5xx' }),
  });

  renderHook(() => useKnaufIndexStatus({ files: filesMap, setFiles }));

  await advanceOneTick(); // failed fetch → no setter write
  expect(filesMap.get('p1')?.indexing?.status).toBe('queued');

  await advanceOneTick(); // next tick succeeds → terminal failed recorded
  expect(filesMap.get('p1')?.indexing?.status).toBe('failed');
  expect(filesMap.get('p1')?.embedded).toBeUndefined(); // only ready flips it
});
// End [knauf]
