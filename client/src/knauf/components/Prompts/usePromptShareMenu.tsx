import { useCallback, useState } from 'react';
import type { RefObject } from 'react';
import {
  PermissionBits,
  Permissions,
  PermissionTypes,
  ResourceType,
  SystemRoles,
} from 'librechat-data-provider';
import type { TPromptGroup } from 'librechat-data-provider';
import {
  useAuthContext,
  useCanSharePublic,
  useHasAccess,
  usePeoplePickerPermissions,
  useResourcePermissions,
} from '~/hooks';
import { GenericGrantAccessDialog } from '~/components/Sharing';

export default function usePromptShareMenu(
  group: TPromptGroup,
  menuButtonRef: RefObject<HTMLButtonElement>,
) {
  const { user } = useAuthContext();
  const hasShareAccess = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.SHARE,
  });
  const { hasPeoplePickerAccess } = usePeoplePickerPermissions();
  const canSharePublic = useCanSharePublic(ResourceType.PROMPTGROUP);
  const { hasPermission, isLoading } = useResourcePermissions(
    ResourceType.PROMPTGROUP,
    group._id ?? '',
  );
  const [open, setOpen] = useState(false);

  const canShare =
    Boolean(group._id) &&
    hasShareAccess &&
    (hasPeoplePickerAccess || canSharePublic) &&
    !isLoading &&
    (group.author === user?.id ||
      user?.role === SystemRoles.ADMIN ||
      hasPermission(PermissionBits.SHARE));

  const openShareDialog = useCallback(() => setOpen(true), []);
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        requestAnimationFrame(() => menuButtonRef.current?.focus({ preventScroll: true }));
      }
    },
    [menuButtonRef],
  );

  return {
    canShare,
    openShareDialog,
    shareDialog: canShare ? (
      <GenericGrantAccessDialog
        resourceDbId={group._id}
        resourceName={group.name}
        resourceType={ResourceType.PROMPTGROUP}
        open={open}
        onOpenChange={handleOpenChange}
        hideTrigger={true}
      />
    ) : null,
  };
}
