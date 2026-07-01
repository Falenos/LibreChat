import { FileSources, FileContext } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle } from '@librechat/client';
import { useGetFiles } from '~/data-provider';
import { DataTable, columns } from './Table';
// [knauf] KK20-204 — collapse content-hash dedup duplicates to one row per asset.
import { dedupeLibraryFilesByAsset } from '~/knauf/hooks/Files/dedupeLibraryFiles';
// End [knauf]
import { useLocalize } from '~/hooks';

export function MyFilesModal({
  open,
  onOpenChange,
  triggerRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: React.RefObject<HTMLButtonElement | HTMLDivElement | null>;
}) {
  const localize = useLocalize();

  const { data: files = [] } = useGetFiles<TFile[]>({
    // [knauf] KK20-204 — dedupe to one row per content-hash dedup asset (owner row
    // preferred) BEFORE normalizing context/filterSource, so the manager shows each
    // file once instead of once per upload.
    select: (files) =>
      dedupeLibraryFilesByAsset(files).map((file) => {
        file.context = file.context ?? FileContext.unknown;
        file.filterSource = file.source === FileSources.firebase ? FileSources.local : file.source;
        return file;
      }),
    // End [knauf]
  });

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogContent
        title={localize('com_nav_my_files')}
        className="w-11/12 bg-background text-text-primary shadow-2xl"
      >
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_nav_my_files')}</OGDialogTitle>
        </OGDialogHeader>
        <DataTable columns={columns} data={files} />
      </OGDialogContent>
    </OGDialog>
  );
}
