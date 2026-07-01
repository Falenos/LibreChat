/**
 * [knauf] KK20-204 — de-duplicate the file-manager / library list by content-hash
 * dedup asset.
 *
 * Content-hash dedup writes a separate File record per upload — an "owner"
 * (knauf_dedup_owner=true, knauf_asset_id === own file_id) plus "pointer" rows
 * (knauf_asset_id === owner's file_id, same content, distinct file_id). The file
 * manager (`GET /api/files`) returns every record, so the same file shows up once
 * per upload. These helpers collapse the LIST to one row per asset for display,
 * and expand a selected row back to its whole asset group for a "delete the file"
 * (all records + shared blob/vectors).
 *
 * Scope: the library list only (MyFilesModal, FilesPanel) + the manager delete.
 * NOT the message-attachment lookups (RetrievalCall/useFileMap/useAutoSave), which
 * need exact per-message file_ids and must keep the full undeduped list.
 *
 * `knaufAssetKey` is the single asset-id accessor shared with the composer-chip
 * deduper (useFileHandling.ts `dedupeFilesByAsset`).
 */
import type { TFile } from 'librechat-data-provider';

/** The dedup asset a file belongs to, or undefined when it isn't deduped. */
export function knaufAssetKey(file: { knauf_asset_id?: string }): string | undefined {
  const assetId = file.knauf_asset_id;
  return assetId == null || assetId === '' ? undefined : assetId;
}

/**
 * The owner/canonical row of an asset group — the record that physically holds the
 * blob + vectors (knauf_dedup_owner) or, defensively, the row whose own id is the
 * asset id. Preferred as the representative in the deduped list.
 */
export function isPreferredAssetRow(file: TFile): boolean {
  return file.knauf_dedup_owner === true || file.file_id === file.knauf_asset_id;
}

/**
 * Collapse a files list so each dedup asset appears once. Order-preserving (keeps
 * the input order — the server sends updatedAt desc) and owner-preferring: the
 * first row seen for an asset takes a slot; a later owner row replaces that slot in
 * place (no reorder). Files without an asset key (legacy/non-deduped, images) are
 * each kept as unique.
 */
export function dedupeLibraryFilesByAsset(files: TFile[]): TFile[] {
  const slotByAsset = new Map<string, number>();
  const out: TFile[] = [];
  for (const file of files) {
    const key = knaufAssetKey(file);
    if (key === undefined) {
      out.push(file);
      continue;
    }
    const slot = slotByAsset.get(key);
    if (slot === undefined) {
      slotByAsset.set(key, out.length);
      out.push(file);
      continue;
    }
    // Already have a representative for this asset: upgrade it to the owner row
    // if this one is the owner and the current representative is not.
    if (isPreferredAssetRow(file) && !isPreferredAssetRow(out[slot])) {
      out[slot] = file;
    }
  }
  return out;
}

/**
 * Expand each selected (representative) file to every record sharing its dedup
 * asset, using the full undeduped file list. This turns a manager "delete" of one
 * displayed row into a delete of the whole asset group so the shared blob/vectors
 * get GC'd and the row can't resurface from a surviving sibling. Files without an
 * asset key (or whose group isn't in `allFiles`) expand to just themselves.
 * Result is de-duplicated by file_id.
 */
export function expandAssetGroups<T extends TFile>(selected: T[], allFiles: T[]): T[] {
  const groupByAsset = new Map<string, T[]>();
  for (const file of allFiles) {
    const key = knaufAssetKey(file);
    if (key === undefined) {
      continue;
    }
    const group = groupByAsset.get(key);
    if (group) {
      group.push(file);
    } else {
      groupByAsset.set(key, [file]);
    }
  }

  const result: T[] = [];
  const seenIds = new Set<string>();
  const push = (file: T) => {
    if (seenIds.has(file.file_id)) {
      return;
    }
    seenIds.add(file.file_id);
    result.push(file);
  };

  for (const file of selected) {
    const key = knaufAssetKey(file);
    const group = key === undefined ? undefined : groupByAsset.get(key);
    if (group && group.length > 0) {
      group.forEach(push);
    } else {
      push(file);
    }
  }
  return result;
}
