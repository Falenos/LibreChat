/**
 * [knauf] KK20-204 — pins the file-manager list de-duplication and the
 * manager "delete the whole asset group" expansion. Fails if the dedup stops
 * collapsing owner+pointer rows, stops preferring the owner as the shown row, or
 * if a manager delete stops expanding to every record sharing the asset.
 */
import type { TFile } from 'librechat-data-provider';
import {
  knaufAssetKey,
  isPreferredAssetRow,
  dedupeLibraryFilesByAsset,
  expandAssetGroups,
} from './dedupeLibraryFiles';

const mk = (file_id: string, knauf_asset_id?: string, extra: Partial<TFile> = {}): TFile =>
  ({ file_id, knauf_asset_id, ...extra }) as TFile;

/** owner: knauf_dedup_owner true (its own file_id is also the asset id) */
const owner = (id: string) => mk(id, id, { knauf_dedup_owner: true });
/** pointer: shares the owner's asset id, distinct file_id */
const pointer = (id: string, assetId: string) => mk(id, assetId);

describe('knaufAssetKey / isPreferredAssetRow (KK20-204)', () => {
  it('treats missing/empty knauf_asset_id as "no asset"', () => {
    expect(knaufAssetKey(mk('a'))).toBeUndefined();
    expect(knaufAssetKey(mk('a', ''))).toBeUndefined();
    expect(knaufAssetKey(mk('a', 'asset-1'))).toBe('asset-1');
  });
  it('detects the owner via knauf_dedup_owner or file_id === knauf_asset_id', () => {
    expect(isPreferredAssetRow(owner('o'))).toBe(true);
    expect(isPreferredAssetRow(mk('x', 'x'))).toBe(true);
    expect(isPreferredAssetRow(pointer('p', 'o'))).toBe(false);
  });
});

describe('dedupeLibraryFilesByAsset (KK20-204)', () => {
  it('collapses owner + pointer(s) of one asset to a single row', () => {
    const result = dedupeLibraryFilesByAsset([owner('o'), pointer('p1', 'o'), pointer('p2', 'o')]);
    expect(result).toHaveLength(1);
    expect(result[0].file_id).toBe('o');
  });

  it('prefers the owner as representative even when a pointer appears first', () => {
    const result = dedupeLibraryFilesByAsset([pointer('p1', 'o'), owner('o'), pointer('p2', 'o')]);
    expect(result).toHaveLength(1);
    expect(result[0].file_id).toBe('o');
    expect(result[0].knauf_dedup_owner).toBe(true);
  });

  it('keeps rows without an asset id (legacy/images) each as unique', () => {
    const result = dedupeLibraryFilesByAsset([mk('img1'), mk('img2'), mk('doc', '')]);
    expect(result.map((f) => f.file_id)).toEqual(['img1', 'img2', 'doc']);
  });

  it('preserves input order of representatives and dedupes per asset', () => {
    const result = dedupeLibraryFilesByAsset([
      owner('a'),
      pointer('b1', 'B'),
      pointer('a2', 'a'),
      mk('plain'),
      owner('B'),
    ]);
    // 'a' first (owner), then asset B (first-seen slot = b1, upgraded to owner B), then plain
    expect(result.map((f) => f.file_id)).toEqual(['a', 'B', 'plain']);
  });

  it('keeps the first pointer as representative when the owner is already gone', () => {
    const result = dedupeLibraryFilesByAsset([pointer('p1', 'o'), pointer('p2', 'o')]);
    expect(result).toHaveLength(1);
    expect(result[0].file_id).toBe('p1');
  });
});

describe('expandAssetGroups (KK20-204)', () => {
  const all = [owner('o'), pointer('p1', 'o'), pointer('p2', 'o'), mk('img'), owner('other')];

  it('expands a selected representative to every sibling sharing its asset', () => {
    const result = expandAssetGroups([owner('o')], all);
    expect(result.map((f) => f.file_id).sort()).toEqual(['o', 'p1', 'p2']);
  });

  it('expands a row without an asset id to just itself', () => {
    expect(expandAssetGroups([mk('img')], all).map((f) => f.file_id)).toEqual(['img']);
  });

  it('de-dupes emitted rows by file_id', () => {
    const result = expandAssetGroups([owner('o'), pointer('p1', 'o')], all);
    expect(result.map((f) => f.file_id).sort()).toEqual(['o', 'p1', 'p2']);
  });

  it('falls back to the selected row when the cache is empty', () => {
    expect(expandAssetGroups([owner('o')], []).map((f) => f.file_id)).toEqual(['o']);
  });

  it('still expands to surviving pointers when the owner is already gone', () => {
    const survivors = [pointer('p1', 'o'), pointer('p2', 'o')];
    const result = expandAssetGroups([pointer('p1', 'o')], survivors);
    expect(result.map((f) => f.file_id).sort()).toEqual(['p1', 'p2']);
  });
});
