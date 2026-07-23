/**
 * [knauf] KK20-204 — pins the content-hash dedup collapse for chat attachments.
 *
 * The server mints a distinct file_id per upload but points repeat uploads of
 * identical content at one shared knauf_asset_id. `dedupeFilesByAsset` (a
 * [knauf] seam in the upstream useFileHandling hook) collapses the composer's
 * file Map so an identical re-attachment appears — and sends — only once. This
 * spec fails if that collapse breaks or if knauf_asset_id stops being honoured.
 */
import {
  dedupeFilesByAsset,
  limitIncomingFiles,
  limitIncomingFilesByTotalSize,
} from '~/hooks/Files/useFileHandling';
import type { ExtendedFile } from '~/common';

const mk = (file_id: string, knauf_asset_id?: string): ExtendedFile =>
  ({ file_id, knauf_asset_id, size: 0, progress: 1 }) as ExtendedFile;

describe('dedupeFilesByAsset (KK20-204)', () => {
  it('returns the same Map reference when there are no duplicates (no needless re-render)', () => {
    const files = new Map<string, ExtendedFile>([
      ['a', mk('a', 'asset-1')],
      ['b', mk('b', 'asset-2')],
    ]);
    expect(dedupeFilesByAsset(files)).toBe(files);
  });

  it('collapses entries sharing a knauf_asset_id, keeping the first', () => {
    const files = new Map<string, ExtendedFile>([
      ['temp-a', mk('owner', 'asset-1')],
      ['temp-b', mk('pointer', 'asset-1')],
    ]);
    const result = dedupeFilesByAsset(files);
    expect(result).not.toBe(files);
    expect(result.size).toBe(1);
    expect(result.get('temp-a')?.file_id).toBe('owner');
    expect(result.has('temp-b')).toBe(false);
  });

  it('leaves entries without a knauf_asset_id untouched (non-deduped uploads, images)', () => {
    const files = new Map<string, ExtendedFile>([
      ['x', mk('x')],
      ['y', mk('y')],
    ]);
    expect(dedupeFilesByAsset(files)).toBe(files);
  });

  it('dedupes independently per asset and preserves non-deduped entries', () => {
    const files = new Map<string, ExtendedFile>([
      ['a1', mk('a1', 'asset-1')],
      ['b1', mk('b1', 'asset-2')],
      ['a2', mk('a2', 'asset-1')],
      ['plain', mk('plain')],
      ['b2', mk('b2', 'asset-2')],
    ]);
    const result = dedupeFilesByAsset(files);
    expect(result.size).toBe(3);
    expect([...result.keys()]).toEqual(['a1', 'b1', 'plain']);
  });
});

describe('limitIncomingFiles (KK20-227)', () => {
  const files = ['a', 'b', 'c'].map((name) => new File([name], `${name}.pdf`));

  it('accepts only the remaining slots and reports the rejected files', () => {
    expect(limitIncomingFiles(files, 4, 5)).toEqual({ accepted: [files[0]], rejected: 2 });
  });

  it('rejects all incoming files when the message is already at the limit', () => {
    expect(limitIncomingFiles(files, 5, 5)).toEqual({ accepted: [], rejected: 3 });
  });
});

describe('limitIncomingFilesByTotalSize', () => {
  const mb = 1024 * 1024;
  const sizedFile = (name: string, size: number) => {
    const file = new File(['x'], name);
    Object.defineProperty(file, 'size', { value: size });
    return file;
  };

  it('keeps considering smaller files after one file does not fit', () => {
    const files = [
      sizedFile('60.pdf', 60 * mb),
      sizedFile('50.pdf', 50 * mb),
      sizedFile('40.pdf', 40 * mb),
    ];

    expect(limitIncomingFilesByTotalSize(files, 0, 100 * mb)).toEqual({
      accepted: [files[0], files[2]],
      rejected: 1,
    });
  });

  it('includes a file that reaches the aggregate limit exactly', () => {
    const files = [sizedFile('20.pdf', 20 * mb), sizedFile('10.pdf', 10 * mb)];

    expect(limitIncomingFilesByTotalSize(files, 90 * mb, 100 * mb)).toEqual({
      accepted: [files[1]],
      rejected: 1,
    });
  });

  it('accepts every file when the aggregate limit is disabled', () => {
    const files = [sizedFile('a.pdf', 60 * mb), sizedFile('b.pdf', 50 * mb)];

    expect(limitIncomingFilesByTotalSize(files, 0, 0)).toEqual({
      accepted: files,
      rejected: 0,
    });
  });
});
