/**
 * Knauf seam test — marketplace visibility for built-in USER.
 *
 * Pins the `[knauf]` block inside `client/src/hooks/Nav/useShowMarketplace.ts`:
 * a normal USER must have at least one accessible agent before the marketplace
 * link appears, while admins/custom roles keep permission-only behavior.
 */
import React from 'react';
import { renderHook } from '@testing-library/react';
import { Permissions, PermissionTypes, SystemRoles } from 'librechat-data-provider';

const mockUseHasAccess = jest.fn();
const mockUseListAgentsQuery = jest.fn();

jest.mock('~/hooks', () => {
  const actualAuth = jest.requireActual('~/hooks/AuthContext');
  return {
    AuthContext: actualAuth.AuthContext,
    useHasAccess: (params: unknown) => mockUseHasAccess(params),
  };
});

jest.mock('~/data-provider', () => ({
  useListAgentsQuery: (params: unknown, config: unknown) => mockUseListAgentsQuery(params, config),
}));

import { AuthContext } from '~/hooks';
import useShowMarketplace from '~/hooks/Nav/useShowMarketplace';

const accessByType = new Map<PermissionTypes, boolean>();

function renderMarketplaceHook(role: SystemRoles | string = SystemRoles.USER) {
  const authValue = {
    isAuthenticated: true,
    user: {
      id: 'user-1',
      role,
    },
  };

  return renderHook(() => useShowMarketplace(), {
    wrapper: ({ children }) => (
      <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>
    ),
  });
}

describe('useShowMarketplace — Knauf USER accessible-agent gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    accessByType.clear();
    accessByType.set(PermissionTypes.AGENTS, true);
    accessByType.set(PermissionTypes.MARKETPLACE, true);
    mockUseHasAccess.mockImplementation(
      ({
        permissionType,
        permission,
      }: {
        permissionType: PermissionTypes;
        permission: Permissions;
      }) => permission === Permissions.USE && accessByType.get(permissionType) === true,
    );
    mockUseListAgentsQuery.mockReturnValue({ data: { data: [] } });
  });

  it('hides marketplace when base marketplace permission is missing', () => {
    accessByType.set(PermissionTypes.MARKETPLACE, false);

    const { result } = renderMarketplaceHook(SystemRoles.USER);

    expect(result.current).toBe(false);
  });

  it('hides marketplace for USER with no accessible agents', () => {
    mockUseListAgentsQuery.mockReturnValue({ data: { data: [] } });

    const { result } = renderMarketplaceHook(SystemRoles.USER);

    expect(result.current).toBe(false);
  });

  it('shows marketplace for USER once an agent is accessible', () => {
    mockUseListAgentsQuery.mockReturnValue({ data: { data: [{ id: 'agent-1' }] } });

    const { result } = renderMarketplaceHook(SystemRoles.USER);

    expect(result.current).toBe(true);
  });

  it('does not require accessible-agent data for ADMIN', () => {
    mockUseListAgentsQuery.mockReturnValue({ data: { data: [] } });

    const { result } = renderMarketplaceHook(SystemRoles.ADMIN);

    expect(result.current).toBe(true);
    expect(mockUseListAgentsQuery).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
      expect.objectContaining({ enabled: false }),
    );
  });
});
