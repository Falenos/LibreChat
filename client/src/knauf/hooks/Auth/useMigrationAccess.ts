/**
 * [knauf] useMigrationAccess
 *
 * Checks whether the currently authenticated user is on the migration
 * allowlist. Called once after login; result cached by React Query for
 * the session.
 *
 * Returns:
 *   - allowed: true if the user is in the allowlist
 *   - isLoading: true while the check is in-flight
 *   - isError: true if the request failed (treated as NOT allowed)
 */
import axios from 'axios';
import { useQuery } from '@tanstack/react-query';
import { useAuthContext } from '~/hooks';

const MIGRATION_ACCESS_QUERY_KEY = ['knauf', 'migration-access'];

interface MigrationAccessResponse {
  allowed: boolean;
}

export function useMigrationAccess() {
  const { isAuthenticated } = useAuthContext();

  const query = useQuery<MigrationAccessResponse>(
    MIGRATION_ACCESS_QUERY_KEY,
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
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export default useMigrationAccess;
// End [knauf]
