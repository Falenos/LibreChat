import React, { memo } from 'react';
import { CheckboxButton, VectorIcon } from '@librechat/client';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { useLocalize, useHasAccess } from '~/hooks';
import { useBadgeRowContext } from '~/Providers';

function FileSearch() {
  const localize = useLocalize();
  const context = useBadgeRowContext();
  const { toggleState: fileSearchEnabled, debouncedChange, isPinned } = context?.fileSearch ?? {};

  const canUseFileSearch = useHasAccess({
    permissionType: PermissionTypes.FILE_SEARCH,
    permission: Permissions.USE,
  });

  // [knauf] Hide the BYOK file-search chip on the Knauf chat. Document uploads go
  // through the "Upload files" menu into chat-scoped File Search (KK20-190), so a
  // user-toggled file-search chip is redundant and confusing. Hidden in the UI
  // here — NOT via the FILE_SEARCH permission / interface.fileSearch — so
  // librechat.yaml stays aligned with main and the agent builder is unaffected.
  // `as boolean` keeps the upstream body reachable for clean merges. KK20-190.
  const KNAUF_HIDE_FILE_SEARCH_CHIP = true as boolean;
  if (KNAUF_HIDE_FILE_SEARCH_CHIP) {
    return null;
  }
  // End [knauf]

  if (!canUseFileSearch) {
    return null;
  }

  return (
    <>
      {(fileSearchEnabled || isPinned) && (
        <CheckboxButton
          className="max-w-fit"
          checked={fileSearchEnabled}
          setValue={debouncedChange}
          label={localize('com_assistants_file_search')}
          isCheckedClassName="border-green-600/40 bg-green-500/10 hover:bg-green-700/10"
          icon={<VectorIcon className="icon-md" />}
        />
      )}
    </>
  );
}

export default memo(FileSearch);
