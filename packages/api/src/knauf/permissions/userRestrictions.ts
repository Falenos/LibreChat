import { Permissions, PermissionTypes, SystemRoles } from 'librechat-data-provider';
import { isEnabled } from '~/utils';

export type PermissionUpdate = Partial<
  Record<PermissionTypes, Record<string, boolean | undefined>>
>;

const KNAUF_RESTRICT_USER_PERMISSIONS = 'KNAUF_RESTRICT_USER_PERMISSIONS';
const KNAUF_RESTRICT_PROD_USER_PERMISSIONS = 'KNAUF_RESTRICT_PROD_USER_PERMISSIONS';

const KNAUF_RESTRICTED_USER_PERMISSION_TYPES = new Set<PermissionTypes>([
  PermissionTypes.PROMPTS,
  PermissionTypes.AGENTS,
  PermissionTypes.MEMORIES,
  PermissionTypes.MULTI_CONVO,
  PermissionTypes.RUN_CODE,
  PermissionTypes.WEB_SEARCH,
  PermissionTypes.FILE_SEARCH,
  PermissionTypes.MCP_SERVERS,
  PermissionTypes.REMOTE_AGENTS,
]);

function isKnaufUserRestrictionEnabled() {
  return (
    isEnabled(process.env[KNAUF_RESTRICT_USER_PERMISSIONS]) ||
    isEnabled(process.env[KNAUF_RESTRICT_PROD_USER_PERMISSIONS])
  );
}

export function shouldApplyKnaufUserRestriction(
  roleName: string,
  permType?: PermissionTypes,
): boolean {
  if (roleName !== SystemRoles.USER) {
    return false;
  }
  if (!isKnaufUserRestrictionEnabled()) {
    return false;
  }
  return permType === undefined || KNAUF_RESTRICTED_USER_PERMISSION_TYPES.has(permType);
}

export function applyKnaufUserRestrictions(
  roleName: string,
  permissions: PermissionUpdate,
  existingPermissions?: PermissionUpdate,
): PermissionUpdate {
  if (!shouldApplyKnaufUserRestriction(roleName)) {
    return permissions;
  }

  return {
    ...permissions,
    [PermissionTypes.PROMPTS]: existingPermissions?.[PermissionTypes.PROMPTS]
      ? { [Permissions.SHARE_PUBLIC]: false }
      : {
          ...permissions[PermissionTypes.PROMPTS],
          [Permissions.SHARE_PUBLIC]: false,
        },
    [PermissionTypes.AGENTS]: {
      ...permissions[PermissionTypes.AGENTS],
      [Permissions.CREATE]: false,
      [Permissions.SHARE]: false,
      [Permissions.SHARE_PUBLIC]: false,
    },
    [PermissionTypes.MEMORIES]: {
      ...permissions[PermissionTypes.MEMORIES],
      [Permissions.USE]: false,
      [Permissions.CREATE]: false,
      [Permissions.READ]: false,
      [Permissions.UPDATE]: false,
      [Permissions.OPT_OUT]: false,
    },
    [PermissionTypes.MULTI_CONVO]: {
      ...permissions[PermissionTypes.MULTI_CONVO],
      [Permissions.USE]: false,
    },
    [PermissionTypes.RUN_CODE]: {
      ...permissions[PermissionTypes.RUN_CODE],
      [Permissions.USE]: false,
    },
    [PermissionTypes.WEB_SEARCH]: {
      ...permissions[PermissionTypes.WEB_SEARCH],
      [Permissions.USE]: false,
    },
    [PermissionTypes.FILE_SEARCH]: {
      ...permissions[PermissionTypes.FILE_SEARCH],
      [Permissions.USE]: false,
    },
    [PermissionTypes.MCP_SERVERS]: {
      ...permissions[PermissionTypes.MCP_SERVERS],
      [Permissions.USE]: true,
      [Permissions.CREATE]: false,
      [Permissions.SHARE]: false,
      [Permissions.SHARE_PUBLIC]: false,
    },
    [PermissionTypes.REMOTE_AGENTS]: {
      ...permissions[PermissionTypes.REMOTE_AGENTS],
      [Permissions.USE]: false,
      [Permissions.CREATE]: false,
      [Permissions.SHARE]: false,
      [Permissions.SHARE_PUBLIC]: false,
    },
  };
}
