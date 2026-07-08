import type { TFile } from 'librechat-data-provider';
import { useGetFiles } from '~/data-provider';
import { columns } from './PanelColumns';
import DataTable from './PanelTable';
// [knauf] KK20-204 — one row per content-hash dedup asset in the files panel.
import { dedupeLibraryFilesByAsset } from '~/knauf/hooks/Files/dedupeLibraryFiles';
// End [knauf]

export default function FilesPanel() {
  // [knauf] KK20-204 — collapse dedup duplicates to one row per asset.
  const { data: files = [] } = useGetFiles<TFile[]>({
    select: (files) => dedupeLibraryFilesByAsset(files),
  });
  // End [knauf]

  return (
    <div className="h-auto w-full px-3 pb-3 pt-2">
      <DataTable columns={columns} data={files} />
    </div>
  );
}
