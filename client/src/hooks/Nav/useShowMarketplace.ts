import { useContext, useMemo } from 'react';
// [knauf] USER marketplace visibility also depends on whether any agent is accessible.
import { PermissionBits, PermissionTypes, Permissions, SystemRoles } from 'librechat-data-provider';
import { useListAgentsQuery } from '~/data-provider';
// End [knauf]
import { useHasAccess, AuthContext } from '~/hooks';

/**
 * Hook to determine if the Agent Marketplace should be shown.
 * Consolidates the logic for checking:
 * - Auth readiness (avoid race conditions)
 * - Access to Agents permission
 * - Access to Marketplace permission
 *
 * @returns Whether the Agent Marketplace should be displayed
 */
export default function useShowMarketplace(): boolean {
  const authContext = useContext(AuthContext);

  const hasAccessToAgents = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.USE,
  });

  const hasAccessToMarketplace = useHasAccess({
    permissionType: PermissionTypes.MARKETPLACE,
    permission: Permissions.USE,
  });

  // Check if auth is ready (avoid race conditions)
  const authReady = useMemo(
    () =>
      authContext?.isAuthenticated !== undefined &&
      (authContext?.isAuthenticated === false || authContext?.user !== undefined),
    [authContext?.isAuthenticated, authContext?.user],
  );

  // [knauf] Hide marketplace for built-in USER until at least one agent has
  // been shared/otherwise made accessible beyond the default Karl chat spec.
  // Admins and custom roles keep the upstream permission-based behavior.
  const hasBaseMarketplaceAccess = authReady && hasAccessToAgents && hasAccessToMarketplace;
  const isBuiltInUser = authContext?.user?.role === SystemRoles.USER;
  const { data: accessibleAgents } = useListAgentsQuery(
    {
      limit: 1,
      requiredPermission: PermissionBits.VIEW,
    },
    {
      enabled: hasBaseMarketplaceAccess && isBuiltInUser,
      // [knauf] Keep the last successful USER gate result during background
      // refreshes. Cold loads still stay hidden until the server confirms at
      // least one accessible agent.
      keepPreviousData: true,
    },
  );

  if (!hasBaseMarketplaceAccess) {
    return false;
  }

  if (!isBuiltInUser) {
    return true;
  }

  return (accessibleAgents?.data?.length ?? 0) > 0;
  // End [knauf]
}
