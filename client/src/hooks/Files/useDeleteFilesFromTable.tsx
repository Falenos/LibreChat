import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';
import type { BatchFile, TFile } from 'librechat-data-provider';
import { useDeleteFilesMutation } from '~/data-provider';
import useFileDeletion from './useFileDeletion';
// [knauf] KK20-204 — expand a manager delete to the whole content-hash asset group.
import { expandAssetGroups } from '~/knauf/hooks/Files/dedupeLibraryFiles';
// End [knauf]

export default function useDeleteFilesFromTable(callback?: () => void) {
  const queryClient = useQueryClient();
  const deletionMutation = useDeleteFilesMutation({
    onMutate: async (variables) => {
      const { files } = variables;
      if (!files.length) {
        return new Map<string, BatchFile>();
      }

      const filesToDeleteMap = files.reduce((map, file) => {
        map.set(file.file_id, file);
        return map;
      }, new Map<string, BatchFile>());

      return { filesToDeleteMap };
    },
    onSuccess: (data, variables, context) => {
      console.log('Files deleted');
      const { filesToDeleteMap } = context as { filesToDeleteMap: Map<string, BatchFile> };

      queryClient.setQueryData([QueryKeys.files], (oldFiles: TFile[] | undefined) => {
        const { files } = variables;
        return files.length
          ? oldFiles?.filter((file) => !filesToDeleteMap.has(file.file_id))
          : oldFiles;
      });
      callback?.();
    },
    onError: (error) => {
      console.log('Error deleting files:', error);
      callback?.();
    },
  });

  // [knauf] KK20-204 — the file manager shows one row per dedup asset, so a delete
  // there means "delete this file entirely". Expand each selected row to every File
  // record sharing its knauf_asset_id (from the full undeduped files cache) before
  // deleting, so the shared blob/vectors are GC'd and the row can't resurface from a
  // surviving sibling. Rows without an asset key delete just themselves. The in-chat
  // single detach (useFileDeletion.deleteFile) is untouched.
  const { deleteFile, deleteFiles: deleteFilesBase } = useFileDeletion({
    mutateAsync: deletionMutation.mutateAsync,
  });

  const deleteFiles = useCallback(
    (args: Parameters<typeof deleteFilesBase>[0]) => {
      const allFiles = queryClient.getQueryData<TFile[]>([QueryKeys.files]) ?? [];
      deleteFilesBase({ ...args, files: expandAssetGroups(args.files as TFile[], allFiles) });
    },
    [deleteFilesBase, queryClient],
  );

  return { deleteFile, deleteFiles };
  // End [knauf]
}
