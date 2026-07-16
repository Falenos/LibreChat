// [knauf] KK20-195 WP5a — pure-function tests for the indexing predicates and
// the §6.5 submit-map filter.
import type { ExtendedFile } from '~/common';
import {
  isIndexingPending,
  isIndexingTerminal,
  hasPendingIndexing,
  filterIndexReadyFiles,
  type KnaufFileIndexing,
} from './fileIndexing';

const indexing = (overrides: Partial<KnaufFileIndexing>): KnaufFileIndexing => ({
  status: 'queued',
  ready: false,
  retryable: false,
  error_code: null,
  queued_at: null,
  ...overrides,
});

const file = (id: string, ix?: KnaufFileIndexing): ExtendedFile =>
  ({ file_id: id, size: 1, progress: 1, indexing: ix }) as ExtendedFile;

describe('isIndexingPending / isIndexingTerminal', () => {
  test('no projection (legacy / sync upload) is terminal, never pending', () => {
    expect(isIndexingPending(undefined)).toBe(false);
    expect(isIndexingTerminal(undefined)).toBe(true);
  });

  test('queued / processing are pending', () => {
    expect(isIndexingPending(indexing({ status: 'queued' }))).toBe(true);
    expect(isIndexingPending(indexing({ status: 'processing' }))).toBe(true);
  });

  test('ready and failed are terminal', () => {
    expect(isIndexingTerminal(indexing({ status: 'ready', ready: true }))).toBe(true);
    expect(isIndexingTerminal(indexing({ status: 'failed', retryable: true }))).toBe(true);
  });

  test('a replacement re-index stays terminal (ready=true while processing)', () => {
    expect(isIndexingTerminal(indexing({ status: 'processing', ready: true }))).toBe(true);
  });
});

describe('hasPendingIndexing (the send gate)', () => {
  test('true only while some attachment is pending', () => {
    const pending = new Map([
      ['a', file('a')],
      ['b', file('b', indexing({ status: 'queued' }))],
    ]);
    expect(hasPendingIndexing(pending)).toBe(true);

    const settled = new Map([
      ['a', file('a')],
      ['b', file('b', indexing({ status: 'failed' }))],
      ['c', file('c', indexing({ status: 'ready', ready: true }))],
    ]);
    expect(hasPendingIndexing(settled)).toBe(false);
  });
});

describe('filterIndexReadyFiles (the submit-map filter)', () => {
  test('keeps legacy + ready files, drops pending and failed', () => {
    const files = [
      file('legacy'),
      file('ready', indexing({ status: 'ready', ready: true })),
      file('pending', indexing({ status: 'processing' })),
      file('failed', indexing({ status: 'failed', error_code: 'rag_5xx' })),
    ];
    expect(filterIndexReadyFiles(files).map((f) => f.file_id)).toEqual(['legacy', 'ready']);
  });
});
// End [knauf]
