/**
 * [knauf] useMigrationAccess
 *
 * Checks whether the currently authenticated user is on the migration
 * allowlist. Called once after login; result cached by React Query for
 * the session.
 *
 * Returns:
 *   - allowed: true if the user is in the allowlist
 *   - isLoading: true while the initial fetch is in-flight
 *   - isError: true if the request failed
 *   - hasData: true if at least one successful response has been received
 */
import axios from 'axios';
import { useQuery } from '@tanstack/react-query';
import { useAuthContext } from '~/hooks';

interface MigrationAccessResponse {
  allowed: boolean;
}

export function useMigrationAccess() {
  const { isAuthenticated, user } = useAuthContext();

  // Include email in the key so each user gets an isolated cache entry.
  // Prevents a logged-out user's result being briefly shown to the next user
  // who logs in on the same tab.
  const query = useQuery<MigrationAccessResponse>(
    ['knauf', 'migration-access', user?.email ?? ''],
    async () => {
      const { data } = await axios.get<MigrationAccessResponse>('/api/knauf/migration/access');
      return data;
    },
    {
      enabled: isAuthenticated,
      staleTime: 0,   // always re-check on focus; backend cache (MIGRATION_ALLOWLIST_CACHE_TTL_MINUTES) is the gate
      retry: 1,
    },
  );

  return {
    allowed: query.data?.allowed ?? false,
    isLoading: query.isInitialLoading,
    isError: query.isError,
    // true once at least one successful fetch has completed.
    // Root.tsx uses this to avoid showing the error screen when a background
    // refetch fails but we already have a confirmed allowed=true result.
    hasData: query.dataUpdatedAt > 0,
  };
}

export default useMigrationAccess;
// End [knauf]
